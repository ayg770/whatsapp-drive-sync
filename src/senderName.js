export function normalizeSenderId(id) {
  return typeof id === 'string' ? id.replace(/:\d+@/, '@') : id;
}

export function rememberContactNames(names, contacts) {
  for (const contact of contacts || []) {
    const name = [contact.name, contact.notify, contact.verifiedName]
      .find(value => typeof value === 'string' && value.trim());
    if (!name) continue;
    for (const id of [contact.id, contact.jid, contact.lid]) {
      if (id) names.set(normalizeSenderId(id), name.trim());
    }
  }
}

export function resolveSenderName(msg, names, ownName) {
  const participant = msg.key?.participant || msg.participant;
  // A group JID identifies the group, never the person who sent the photo.
  if (participant && !participant.endsWith('@g.us')) {
    const contactName = names.get(participant) || names.get(normalizeSenderId(participant));
    if (contactName?.trim()) return contactName.trim();
  }
  if (typeof msg.pushName === 'string' && msg.pushName.trim()) return msg.pushName.trim();
  if (msg.key?.fromMe && typeof ownName === 'string' && ownName.trim()) return ownName.trim();
  if (participant && !participant.endsWith('@g.us')) {
    return `שולח ${participant.split('@')[0].split(':')[0]}`;
  }
  return 'שולח לא מזוהה';
}
