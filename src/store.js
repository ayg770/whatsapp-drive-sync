import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const LAST_SYNCED_FILE = path.join(DATA_DIR, 'last-synced.json');
const UPLOADED_FILE = path.join(DATA_DIR, 'uploaded-images.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error('Persistent sync state could not be read');
  }
}

function writeJson(file, value) {
  ensureDataDir();
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Shared across everyone who ever syncs, keyed by WhatsApp group JID, so that
// two different people syncing the same group don't both upload the same photos.
export function getGroupLastSynced(groupId) {
  const all = readJson(LAST_SYNCED_FILE, {});
  return all[groupId] || 0;
}

export function setGroupLastSynced(groupId, timestampMs) {
  const all = readJson(LAST_SYNCED_FILE, {});
  all[groupId] = timestampMs;
  writeJson(LAST_SYNCED_FILE, all);
}

// Each visitor gets a private, throwaway folder for their WhatsApp link
// (deleted again once their sync finishes or their session expires).
export function sessionAuthDir(sessionId) {
  ensureDataDir();
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function removeSessionAuthDir(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
}

ensureDataDir();

// Track successfully uploaded WhatsApp message IDs rather than advancing a group
// timestamp past images that may have failed to download or upload.
export function wasImageUploaded(groupId, messageId) {
  if (!groupId || !messageId) return false;
  const all = readJson(UPLOADED_FILE, {});
  return Boolean(all[groupId]?.[messageId]);
}

export function markImageUploaded(groupId, messageId) {
  if (!groupId || !messageId) return;
  const all = readJson(UPLOADED_FILE, {});
  if (!all[groupId]) all[groupId] = {};
  all[groupId][messageId] = true;
  writeJson(UPLOADED_FILE, all);
}

const RESERVED_IDS_FILE = path.join(DATA_DIR, 'drive-image-ids.json');
export function getReservedImageId(key) {
  return readJson(RESERVED_IDS_FILE, {})[key];
}
export function reserveImageId(key, id) {
  const ids = readJson(RESERVED_IDS_FILE, {});
  ids[key] = id;
  writeJson(RESERVED_IDS_FILE, ids);
}
