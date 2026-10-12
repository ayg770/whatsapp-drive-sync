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

  return Boolean(extractImageMessage(msg.message));
}

export function messageIdentity(msg) {
  return `${msg.key?.remoteJid}:${msg.key?.id}`;
}
export function senderName(msg, contacts, ownName) {
  // pushName belongs to the sender of this message, not the syncing visitor.
  if (msg.pushName?.trim()) return msg.pushName.trim();
  const participant = msg.key?.participant || msg.participant;
  const known = contacts.get(participant) || contacts.get(normalizeParticipant(participant));
  if (known) return known;
  if (msg.key?.fromMe && ownName) return ownName;
  return participant ? `שולח ${participant.split('@')[0].split(':')[0]}` : 'שולח לא מזוהה';
}

export function normalizeParticipant(jid) {
  return typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : jid;
}
