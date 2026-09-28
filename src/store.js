import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const LAST_SYNCED_FILE = path.join(DATA_DIR, 'last-synced.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeSessionAuthDir(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
}

ensureDataDir();
