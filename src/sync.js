import { loadCaptured, saveCaptured, saveLastSelection, loadGroups } from './store.js';
import { getOrCreateDateFolder, uploadFile, folderUrl } from './driveClient.js';

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-').trim();
}

function dateFolderName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeSuffix(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}-${m}-${s}`;
}

export async function exportSelectedGroups(groupIds) {
  const parentId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  if (!parentId) {
    throw new Error('GOOGLE_DRIVE_PARENT_FOLDER_ID is not set in .env');
  }
  if (!groupIds?.length) {
    throw new Error('No groups selected');
  }

  const captured = loadCaptured();
  const groups = loadGroups();
  const groupNameById = Object.fromEntries(groups.map((g) => [g.id, g.name]));

  const pending = captured.filter((item) => !item.exported && groupIds.includes(item.groupId));

  if (!pending.length) {
    saveLastSelection(groupIds);
    return { uploaded: 0, bySender: {}, folderUrl: null };
  }

  const folderName = dateFolderName(new Date());
  const folderId = await getOrCreateDateFolder(folderName, parentId);

  const bySender = {};
  const usedNames = new Set();

  for (const item of pending) {
    const senderName = sanitize(item.senderName || item.senderId);
    let fileName = `${senderName}_${timeSuffix(new Date(item.timestamp))}.${item.ext}`;
    // Guard against two photos from the same sender in the same second.
    let attempt = 1;
    while (usedNames.has(fileName)) {
      attempt += 1;
      fileName = `${senderName}_${timeSuffix(new Date(item.timestamp))}-${attempt}.${item.ext}`;
    }
    usedNames.add(fileName);

    const mimeType = item.ext === 'png' ? 'image/png' : 'image/jpeg';
    await uploadFile(item.localPath, fileName, mimeType, folderId);

    item.exported = true;
    bySender[senderName] = (bySender[senderName] || 0) + 1;
  }

  saveCaptured(captured);
  saveLastSelection(groupIds);

  return {
    uploaded: pending.length,
    bySender,
    folderName,
    folderUrl: folderUrl(folderId),
    groups: groupIds.map((id) => groupNameById[id] || id),
  };
}
