import path from 'path';
import fs from 'fs';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { addCaptured, incomingDir, authDir, saveGroups } from './store.js';

const logger = pino({ level: 'silent' });

let sock = null;

// Unwraps common WhatsApp message wrappers to find an actual image payload.
function extractImageMessage(message) {
  if (!message) return null;
  if (message.imageMessage) return message.imageMessage;
  const wrapped =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message;
  if (wrapped) return extractImageMessage(wrapped);
  return null;
}

async function refreshGroupNames() {
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participantCount: g.participants?.length ?? 0,
    }));
    saveGroups(list);
  } catch (err) {
    console.error('Failed to refresh group list:', err.message);
  }
}

async function handleIncomingMessage(msg) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || !remoteJid.endsWith('@g.us')) return;
  if (msg.key.fromMe) return;

  const imageMessage = extractImageMessage(msg.message);
  if (!imageMessage) return;

  const senderId = msg.key.participant || remoteJid;
  const senderName = msg.pushName || senderId.split('@')[0];
  const timestamp = Number(msg.messageTimestamp) * 1000 || Date.now();

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    const ext = imageMessage.mimetype?.includes('png') ? 'png' : 'jpg';
    const fileName = `${msg.key.id}.${ext}`;
    const filePath = path.join(incomingDir(), fileName);
    fs.writeFileSync(filePath, buffer);

    addCaptured({
      id: msg.key.id,
      groupId: remoteJid,
      senderId,
      senderName,
      timestamp,
      localPath: filePath,
      ext,
      exported: false,
    });

    console.log(`Captured photo from ${senderName} in group ${remoteJid}`);
  } catch (err) {
    console.error('Failed to download/save incoming photo:', err.message);
  }
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir());

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp connected.');
      refreshGroupNames();
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('WhatsApp connection closed.', loggedOut ? '(logged out)' : '(reconnecting...)');
      if (!loggedOut) {
        startWhatsApp();
      }
    }
  });

  sock.ev.on('groups.upsert', refreshGroupNames);
  sock.ev.on('groups.update', refreshGroupNames);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });

  return sock;
}

export function getSock() {
  return sock;
}

export async function refreshGroups() {
  await refreshGroupNames();
}
