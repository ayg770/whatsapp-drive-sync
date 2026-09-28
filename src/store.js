import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const CAPTURED_FILE = path.join(DATA_DIR, 'captured.json');
const SELECTION_FILE = path.join(DATA_DIR, 'last-selection.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'incoming'), { recursive: true });
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

export function loadCaptured() {
  return readJson(CAPTURED_FILE, []);
}

export function saveCaptured(items) {
  writeJson(CAPTURED_FILE, items);
}

export function addCaptured(item) {
  const items = loadCaptured();
  items.push(item);
  saveCaptured(items);
}

export function loadLastSelection() {
  return readJson(SELECTION_FILE, { groupIds: [] }).groupIds;
}

export function saveLastSelection(groupIds) {
  writeJson(SELECTION_FILE, { groupIds, savedAt: new Date().toISOString() });
}

export function loadGroups() {
  return readJson(GROUPS_FILE, []);
}

export function saveGroups(groups) {
  writeJson(GROUPS_FILE, groups);
}

export function incomingDir() {
  ensureDataDir();
  return path.join(DATA_DIR, 'incoming');
}

export function authDir() {
  ensureDataDir();
  return path.join(DATA_DIR, 'auth');
}

ensureDataDir();
