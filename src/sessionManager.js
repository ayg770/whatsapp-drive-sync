import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import {
  sessionAuthDir,
  removeSessionAuthDir,
  wasImageUploaded,
  markImageUploaded
} from './store.js';
import {
  extractImageMessage,
  isGroupImageMessage,
  messageIdentity,
  normalizeParticipant,
  senderName
} from './waUtils.js';
import { createImageUploader, runImageJob } from './sync.js';

const logger = pino({ level: 'silent' });

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000; // give up if nobody scans the QR / enters the code in time
const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // stay linked across several syncs; close only after real inactivity
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 60; // sanity cap regardless of what the visitor picks

function lookbackDaysToMs(lookbackDays) {
  const days = Math.min(
    Math.max(Number(lookbackDays) || DEFAULT_LOOKBACK_DAYS, 1),
    MAX_LOOKBACK_DAYS
  );
  return days * 24 * 60 * 60 * 1000;
}

export function createSessionManager({
  makeSocket = makeWASocket,
  loadAuth = useMultiFileAuthState,
  protocolVersion = fetchLatestBaileysVersion,
  download = downloadMediaMessage,
  authDir = sessionAuthDir,
  removeAuthDir = removeSessionAuthDir,
  uploader = createImageUploader,
  uploadedBefore = wasImageUploaded,
  checkpoint = markImageUploaded
} = {}) {
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
      progress: null, // { current, total } while syncing, so the page can show live progress
      messages: new Map(), // messageId -> raw WA message (candidate group images only)
      chatTimestamps: new Map(), // groupJid -> last activity, to sort groups like WhatsApp's own chat list
      contactNames: new Map(), // participant JID -> real display name, when WhatsApp provides one
      historyComplete: false, // true once WhatsApp reports its history sync is done (isLatest)
      expireTimer: null,
      reconnectTimer: null,
      writes: Promise.resolve(),
      closing: false,
      reconnectAttempts: 0,
      accountKey: null,
      jobId: null,
      jobRunning: false
    };
  }

  function trackChatTimestamps(session, chats) {
    for (const chat of chats || []) {
      if (chat.id?.endsWith('@g.us') && chat.conversationTimestamp) {
        session.chatTimestamps.set(
          chat.id,
          Math.max(
            session.chatTimestamps.get(chat.id) || 0,
            Number(chat.conversationTimestamp) * 1000
          )
        );
      }
    }
  }

  // Chat-level "last activity" from the chats list can arrive late or not at
  // all, so also derive it directly from every group message we actually see
  // (any type, not just images) — this is exactly what WhatsApp's own chat
  // list is ordered by.
  function trackActivityFromMessages(session, messages) {
    for (const msg of messages || []) {
      const groupId = msg.key?.remoteJid;
      if (!groupId?.endsWith('@g.us')) continue;
      const timestamp = Number(msg.messageTimestamp) * 1000;
      if (!timestamp) continue;
      if (timestamp > (session.chatTimestamps.get(groupId) || 0)) {
        session.chatTimestamps.set(groupId, timestamp);
      }
    }
  }

  function trackContactNames(session, contacts) {
    for (const contact of contacts || []) {
      const name = contact.name || contact.notify || contact.verifiedName;
      if (name) {
        for (const id of [contact.id, contact.lid, contact.jid]) {
          if (id) session.contactNames.set(normalizeParticipant(id), name);
        }
      }
    }
  }

  function scheduleExpiry(session, ms, reason) {
    clearTimeout(session.expireTimer);
    session.expireTimer = setTimeout(() => {
      if (session.status !== 'closed') {
        closeSession(session.id, { logout: true }).catch(() => {
          console.error('Expired session cleanup failed');
        });
      }
    }, ms);
  }

  function createSession(phoneNumber) {
    const id = crypto.randomUUID();
    const cleanPhone = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : null;
    const session = newSession(id, cleanPhone);
    sessions.set(id, session);
    scheduleExpiry(session, CONNECT_TIMEOUT_MS, 'no_scan');
    connect(session).catch((err) => {
      session.status = 'error';
      session.error = 'לא ניתן להתחבר לוואטסאפ. נסה להתחבר מחדש.';
    });
    return id;
  }

  async function connect(session) {
    if (session.status === 'closed') return;
    const directory = authDir(session.id);
    const { state, saveCreds } = await loadAuth(directory);

    // Pin to the actual current WhatsApp Web protocol version rather than
    // whatever shipped with this Baileys install — WhatsApp bumping that
    // version server-side is a common cause of "scans fine, then silently
    // fails to link" once the bundled default has drifted out of date.
    let version;
    try {
      ({ version } = await protocolVersion({ timeout: 10000 }));
    } catch (err) {
      console.error('Could not fetch WhatsApp protocol version; using bundled default');
    }

    if (session.status === 'closed') return;
    const sock = makeSocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      syncFullHistory: true,
      defaultQueryTimeoutMs: 30000,
      connectTimeoutMs: 30000,
      ...(version ? { version } : {})
    });
    session.sock = sock;

    sock.ev.on('creds.update', () => {
      if (session.status === 'closed' || session.closing) return;
      session.writes = session.writes
        .then(() => saveCreds())
        .catch(() => {
          session.error = 'שמירת פרטי החיבור נכשלה. התחבר מחדש.';
        });
    });

    sock.ev.on('connection.update', async (update) => {
      if (session.status === 'closed' || session.closing || session.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (connection) {
        console.log(`Session ${session.id}: connection.update -> ${connection}`);
      }

      if (qr && !session.phoneNumber) {
        session.status = 'waiting_qr';
        const qrImage = await qrcode.toDataURL(qr);
        if (session.status === 'closed' || session.closing) return;
        session.qr = qrImage;
      }

      if (connection === 'open') {
        session.reconnectAttempts = 0;
        session.accountKey = crypto
          .createHash('sha256')
          .update((sock.authState.creds.me?.id || '').replace(/:\d+@/, '@'))
          .digest('hex');
        const wasSyncing = session.status === 'syncing';
        if (!wasSyncing) session.status = 'loading_groups';
        session.qr = null;
        session.pairingCode = null;
        if (!wasSyncing) scheduleExpiry(session, IDLE_TIMEOUT_MS, 'idle');

        // Fetch groups immediately; history continues arriving independently.

        try {
          const groups = await sock.groupFetchAllParticipating();
          session.groups = Object.values(groups)
            .map((g) => ({
              id: g.id,
              name: g.subject,
              participantCount: g.participants?.length ?? 0,
              lastActivity: session.chatTimestamps.get(g.id) || 0
            }))
            .sort((a, b) => b.lastActivity - a.lastActivity);
          if (session.status === 'closed' || session.closing || session.sock !== sock) return;
          session.error = null;
          if (!wasSyncing) session.status = 'connected';
        } catch (err) {
          session.status = 'error';
          session.error = 'טעינת הקבוצות נכשלה. התחבר מחדש.';
        }
      }

      if (connection === 'close') {
        const boom = new Boom(lastDisconnect?.error);
        const statusCode = boom?.output?.statusCode;
        console.log(`WhatsApp connection closed: ${statusCode}`);
        if (statusCode === DisconnectReason.loggedOut) {
          await closeSession(session.id);
        } else if (++session.reconnectAttempts <= 5) {
          if (session.status !== 'syncing') session.status = 'starting';
          session.reconnectTimer = setTimeout(
            () =>
              connect(session).catch(() => {
                session.status = 'error';
                session.error = 'החיבור לוואטסאפ נכשל. התחבר מחדש.';
              }),
            Math.min(1000 * 2 ** session.reconnectAttempts, 30000)
          );
        } else {
          session.status = 'error';
          session.error = 'החיבור לוואטסאפ נותק. התחבר מחדש.';
          await closeSession(session.id);
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
      trackChatTimestamps(session, chats);
      trackActivityFromMessages(session, messages);
      trackContactNames(session, contacts);
      for (const msg of messages || []) {
        if (isGroupImageMessage(msg)) session.messages.set(messageIdentity(msg), msg);
      }
      if (isLatest) session.historyComplete = true;
    });

    sock.ev.on('chats.upsert', (chats) => trackChatTimestamps(session, chats));
    sock.ev.on('chats.update', (chats) => trackChatTimestamps(session, chats));
    sock.ev.on('contacts.upsert', (contacts) => trackContactNames(session, contacts));
    sock.ev.on('contacts.update', (contacts) => trackContactNames(session, contacts));

    sock.ev.on('messages.upsert', ({ messages }) => {
      trackActivityFromMessages(session, messages);
      for (const msg of messages || []) {
        if (isGroupImageMessage(msg)) session.messages.set(messageIdentity(msg), msg);
      }
    });
    if (session.phoneNumber && !sock.authState.creds.registered) {
      try {
        const rawCode = await sock.requestPairingCode(session.phoneNumber);
        // Some Baileys versions already return the code with its own dash —
        // strip any punctuation before reformatting, so it can't get doubled
        // up into something that doesn't match what WhatsApp expects.
        const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
        if (session.status === 'closed') return;
        session.pairingCode = cleanCode.match(/.{1,4}/g)?.join('-') || cleanCode;
        session.status = 'waiting_pairing_code';
      } catch (err) {
        session.status = 'error';
        session.error = 'יצירת קוד הקישור נכשלה. התחבר מחדש.';
        return;
      }
    }
  }

  function getPublicState(id) {
    const session = sessions.get(id);
    if (!session) return null;
    return {
      status: session.status,
      qr: session.qr,
      pairingCode: session.pairingCode,
      groups: session.groups
        ?.map((g) => ({
          ...g,
          lastActivity: session.chatTimestamps.get(g.id) || g.lastActivity
        }))
        .sort((a, b) => b.lastActivity - a.lastActivity),
      accountKey: session.accountKey,
      historyComplete: session.historyComplete,
      availableImages: session.messages.size,
      jobId: session.jobId,
      error: session.error,
      summary: session.summary,
      progress: session.progress
    };
  }

  function syncSession(id, groupIds, lookbackDays) {
    const session = sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'connected' || session.jobRunning)
      throw new Error('WhatsApp is not connected yet');
    if (
      !Array.isArray(groupIds) ||
      !groupIds.length ||
      groupIds.some((id) => !session.groups?.some((g) => g.id === id))
    )
      throw new Error('בחר קבוצות מהרשימה בלבד.');
    if (![1, 3, 7, 14, 30].includes(Number(lookbackDays))) throw new Error('בחר תקופה תקינה.');
    const parentId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    if (!parentId) throw new Error('תיקיית היעד בדרייב עדיין לא הוגדרה.');
    session.error = null;
    session.summary = null;

    const oldest = Date.now() - lookbackDaysToMs(lookbackDays);
    const items = [...session.messages.values()]
      .filter(
        (msg) =>
          groupIds.includes(msg.key.remoteJid) && Number(msg.messageTimestamp) * 1000 >= oldest
      )
      .map((msg) => {
        const image = extractImageMessage(msg.message);
        return {
          msg,
          groupId: msg.key.remoteJid,
          messageId: msg.key.id,
          timestamp: Number(msg.messageTimestamp) * 1000,
          senderName: senderName(msg, session.contactNames, session.sock.authState.creds.me?.name),
          groupName: session.groups.find((g) => g.id === msg.key.remoteJid)?.name,
          ext: image.mimetype?.includes('png') ? 'png' : 'jpg',
          mimeType: image.mimetype?.includes('png') ? 'image/png' : 'image/jpeg'
        };
      });
    const upload = uploader(parentId);
    session.jobRunning = true;
    session.status = 'syncing';
    session.jobId = crypto.randomUUID();
    clearTimeout(session.expireTimer);
    session.progress = {
      found: items.length,
      uploaded: 0,
      failed: 0,
      skipped: 0,
      remaining: items.length
    };
    runImageJob(
      items,
      async (item) => {
        if (uploadedBefore(item.groupId, item.messageId)) return { skipped: true };
        const result = await upload(item, () =>
          download(
            item.msg,
            'buffer',
            { options: { timeout: 60000, signal: AbortSignal.timeout(65000) } },
            { logger, reuploadRequest: session.sock.updateMediaMessage }
          )
        );
        checkpoint(item.groupId, item.messageId);
        return result;
      },
      {
        active: () => session.status !== 'closed',
        progress: (value) => {
          session.progress = value;
        }
      }
    )
      .then((summary) => {
        session.summary = summary;
      })
      .catch(() => {
        session.error = 'הסנכרון נכשל. אפשר לנסות שוב; תמונות שאושרו בדרייב לא יועלו שוב.';
      })
      .finally(() => {
        session.jobRunning = false;
        if (session.status !== 'closed') {
          session.status = 'connected';
          scheduleExpiry(session, IDLE_TIMEOUT_MS, 'idle');
        }
      });
    return { jobId: session.jobId };
  }

  async function closeSession(id, { logout = false } = {}) {
    const session = sessions.get(id);
    if (!session) return { loggedOut: false };
    session.closing = true;
    session.status = 'closed';
    let loggedOut = !session.sock?.authState.creds.registered;
    clearTimeout(session.expireTimer);
    clearTimeout(session.reconnectTimer);

    // Actually wait for the logout to reach WhatsApp before tearing down the
    // socket — ending the connection right away could cut it off mid-send, in
    // which case the phone keeps showing the device as linked.
    if (logout && session.sock) {
      try {
        await Promise.race([
          session.sock.logout(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('logout timeout')), 10000);
            timer.unref();
          })
        ]);
        loggedOut = true;
      } catch {
        // already logged out / connection already gone — nothing more to do
      }
    }

    try {
      session.sock?.end();
    } catch {
      // socket may already be closed
    }

    await session.writes;
    removeAuthDir(id);
    session.status = 'closed';
    sessions.delete(id);
    return { loggedOut };
  }

  async function closeAllSessions() {
    await Promise.all([...sessions.keys()].map((id) => closeSession(id, { logout: true })));
  }
  return { createSession, getPublicState, syncSession, closeSession, closeAllSessions };
}
const manager = createSessionManager();
export const { createSession, getPublicState, syncSession, closeSession, closeAllSessions } =
  manager;
