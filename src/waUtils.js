// Unwraps common WhatsApp message wrappers (disappearing / view-once / etc.)
// to find an actual image payload, if the message contains one.
export function extractImageMessage(message) {
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

export function isGroupImageMessage(msg) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || !remoteJid.endsWith('@g.us')) return false;
  if (msg.key.fromMe) return false;
  return Boolean(extractImageMessage(msg.message));
}
