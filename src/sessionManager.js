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

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000; // give up if nobody scans the QR in time
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // close if connected but never synced
const KEEP_AFTER_DONE_MS = 2 * 60 * 1000; // keep the final result available to poll for a bit

const sessions = new Map();

function newSession(id) {
  return {
    id,
    sock: null,
    status: 'starting', // starting | waiting_qr | connected | syncing | done | error | closed
    qr: null,
    groups: null,
    error: null,
    summary: null,
    messages: new Map(), // messageId -> raw WA message (candidate group images only)
    expireTimer: null,
  };
}

function scheduleExpiry(session, ms, reason) {
  clearTimeout(session.expireTimer);
  session.expireTimer = setTimeout(() => {
    if (session.status !== 'closed') {
      closeSession(session.id, { logout: reason === 'idle' });
    }
  }, ms);
}

export function createSession() {
  const id = crypto.randomUUID();
  const session = newSession(id);
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
  });
  session.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = 'waiting_qr';
      session.qr = await qrcode.toDataURL(qr);
      scheduleExpiry(session, CONNECT_TIMEOUT_MS, 'no_scan');
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      scheduleExpiry(session, IDLE_TIMEOUT_MS, 'idle');
      try {
        const groups = await sock.groupFetchAllParticipating();
        session.groups = Object.values(groups).map((g) => ({
          id: g.id,
          name: g.subject,
          participantCount: g.participants?.length ?? 0,
        }));
      } catch (err) {
        session.error = `Could not load groups: ${err.message}`;
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut && session.status !== 'closed' && session.status !== 'done';
      if (shouldReconnect) {
        connect(session).catch((err) => {
          session.status = 'error';
          session.error = err.message;
        });
      } else if (session.status !== 'done') {
        session.status = 'closed';
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ messages }) => {
    for (const msg of messages || []) {
      if (isGroupImageMessage(msg)) session.messages.set(msg.key.id, msg);
    }
  });

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
  await wait(4000);

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

  session.status = 'done';
  session.summary = summary;
  scheduleExpiry(session, KEEP_AFTER_DONE_MS, 'done');
  closeSession(id, { logout: true, keepEntry: true });

  return summary;
}

export function closeSession(id, { logout = false, keepEntry = false } = {}) {
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

  if (keepEntry) {
    session.status = session.status === 'done' ? 'done' : 'closed';
    setTimeout(() => sessions.delete(id), KEEP_AFTER_DONE_MS);
  } else {
    session.status = 'closed';
    sessions.delete(id);
  }
}
