import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { sessionAuthDir, removeSessionAuthDir, getGroupLastSynced, setGroupLastSynced } from './store.js';
import { extractImageMessage, isGroupImageMessage } from './waUtils.js';
import { uploadImages } from './sync.js';

const logger = pino({ level: 'silent' });

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000; // give up if nobody scans the QR / enters the code in time
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // stay linked across several syncs; close only after real inactivity
const HISTORY_MAX_WAIT_MS = 2 * 60 * 1000; // like sitting in WhatsApp Web: wait for the full sync, capped
const HISTORY_POLL_MS = 1000;

const sessions = new Map();

function newSession(id, phoneNumber) {
  return {
    id,
    sock: null,
    // starting | waiting_qr | waiting_pairing_code | connected | syncing | done | error | closed
    status: 'starting',
    qr: null,
    pairingCode: null,
    phoneNumber: phoneNumber || null,
    groups: null,
    error: null,
    summary: null,
    messages: new Map(), // messageId -> raw WA message (candidate group images only)
    chatTimestamps: new Map(), // groupJid -> last activity, to sort groups like WhatsApp's own chat list
    historyComplete: false, // true once WhatsApp reports its history sync is done (isLatest)
    expireTimer: null,
  };
}

// Waits for WhatsApp's own "history sync done" signal, capped at maxMs so a
// slow or unreliable sync never leaves the visitor stuck forever.
function waitForHistorySync(session, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (session.historyComplete || Date.now() - start >= maxMs) resolve();
      else setTimeout(check, HISTORY_POLL_MS);
    };
    check();
  });
}

function trackChatTimestamps(session, chats) {
  for (const chat of chats || []) {
    if (chat.id?.endsWith('@g.us') && chat.conversationTimestamp) {
      session.chatTimestamps.set(chat.id, Number(chat.conversationTimestamp));
    }
  }
}

function scheduleExpiry(session, ms, reason) {
  clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => {
    if (session.status !== 'closed') {
      closeSession(session.id, { logout: reason === 'idle' });
    }
  }, ms);
}

export function createSession(phoneNumber) {
  const id = crypto.randomUUID();
  const cleanPhone = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : null;
  const session = newSession(id, cleanPhone);
  sessions.set(id, session);
  connect(session).catch((err) => {
    session.status = 'error';
    session.error = err.message;
  });
  return id;
}

async function connect(session) {
  const authDir = sessionAuthDir(session.id);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: true,
  });
  session.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  if (session.phoneNumber && !sock.authState.creds.registered) {
    try {
      const rawCode = await sock.requestPairingCode(session.phoneNumber);
      session.pairingCode = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
      session.status = 'waiting_pairing_code';
      scheduleExpiry(session, CONNECT_TIMEOUT_MS, 'no_scan');
    } catch (err) {
      session.status = 'error';
      session.error = `Could not generate a pairing code: ${err.message}`;
      return;
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !session.phoneNumber) {
      session.status = 'waiting_qr';
      session.qr = await qrcode.toDataURL(qr);
      scheduleExpiry(session, CONNECT_TIMEOUT_MS, 'no_scan');
    }

    if (connection === 'open') {
      session.status = 'loading_groups';
      session.qr = null;
      session.pairingCode = null;
      scheduleExpiry(session, IDLE_TIMEOUT_MS, 'idle');

      // Wait for WhatsApp's history sync to actually finish (like staying on
      // WhatsApp Web until it loads) instead of guessing a fixed delay, so
      // groups are ordered by real recent activity and photo history is complete.
      await waitForHistorySync(session, HISTORY_MAX_WAIT_MS);

      try {
        const groups = await sock.groupFetchAllParticipating();
        session.groups = Object.values(groups)
          .map((g) => ({
            id: g.id,
            name: g.subject,
            participantCount: g.participants?.length ?? 0,
            lastActivity: session.chatTimestamps.get(g.id) || 0,
          }))
          .sort((a, b) => b.lastActivity - a.lastActivity);
        session.status = 'connected';
      } catch (err) {
        session.error = `Could not load groups: ${err.message}`;
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut && session.status !== 'closed';
      if (shouldReconnect) {
        connect(session).catch((err) => {
          session.status = 'error';
          session.error = err.message;
        });
      } else {
        session.status = 'closed';
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, messages, isLatest }) => {
    trackChatTimestamps(session, chats);
    for (const msg of messages || []) {
      if (isGroupImageMessage(msg)) session.messages.set(msg.key.id, msg);
    }
    if (isLatest) session.historyComplete = true;
  });

  sock.ev.on('chats.upsert', (chats) => trackChatTimestamps(session, chats));
  sock.ev.on('chats.update', (chats) => trackChatTimestamps(session, chats));

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages || []) {
      if (isGroupImageMessage(msg)) session.messages.set(msg.key.id, msg);
    }
  });
}

export function getPublicState(id) {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    status: session.status,
    qr: session.qr,
    pairingCode: session.pairingCode,
    groups: session.groups,
    error: session.error,
    summary: session.summary,
  };
}

// Give history sync a brief moment to arrive if the visitor clicks "sync"
// right after connecting, then process whatever has come in so far.
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncSession(id, groupIds) {
  const session = sessions.get(id);
  if (!session) throw new Error('Session not found');
  if (session.status !== 'connected') throw new Error('WhatsApp is not connected yet');
  if (!groupIds?.length) throw new Error('No groups selected');

  session.status = 'syncing';
  // The full history wait already happened once at connect time; this is
  // just a short buffer for anything that trickled in since the last sync.
  await wait(3000);

  const groupNameById = Object.fromEntries((session.groups || []).map((g) => [g.id, g.name]));
  const candidates = Array.from(session.messages.values()).filter((msg) =>
    groupIds.includes(msg.key.remoteJid)
  );

  const items = [];
  for (const msg of candidates) {
    const timestamp = Number(msg.messageTimestamp) * 1000 || Date.now();
    const groupId = msg.key.remoteJid;
    if (timestamp <= getGroupLastSynced(groupId)) continue;

    const imageMessage = extractImageMessage(msg.message);
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger, reuploadRequest: session.sock.updateMediaMessage }
      );
      items.push({
        buffer,
        ext: imageMessage.mimetype?.includes('png') ? 'png' : 'jpg',
        mimeType: imageMessage.mimetype?.includes('png') ? 'image/png' : 'image/jpeg',
        senderName: msg.pushName || msg.key.participant?.split('@')[0] || 'unknown',
        timestamp,
        groupId,
      });
    } catch (err) {
      console.error('Failed to download a photo during sync:', err.message);
    }
  }

  const summary = await uploadImages(items, groupNameById, groupIds);

  const latestByGroup = {};
  for (const item of items) {
    latestByGroup[item.groupId] = Math.max(latestByGroup[item.groupId] || 0, item.timestamp);
  }
  for (const [groupId, ts] of Object.entries(latestByGroup)) {
    setGroupLastSynced(groupId, ts);
  }

  // Stay linked: the visitor may want to sync another batch of groups without
  // scanning/pairing again. The link only ends when they close the tab
  // (which sends a beacon to /close) or after real inactivity.
  session.status = 'connected';
  session.summary = summary;
  scheduleExpiry(session, IDLE_TIMEOUT_MS, 'idle');

  return summary;
}

export function closeSession(id, { logout = false } = {}) {
  const session = sessions.get(id);
  if (!session) return;

  clearTimeout(session.expireTimer);

  try {
    if (logout && session.sock) session.sock.logout().catch(() => {});
    session.sock?.end();
  } catch {
    // socket may already be closed
  }

  removeSessionAuthDir(id);
  session.status = 'closed';
  sessions.delete(id);
}
