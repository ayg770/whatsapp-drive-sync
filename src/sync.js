import { getOrCreateDateFolder, uploadBuffer, folderUrl } from './driveClient.js';

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

// items: [{ buffer, ext, mimeType, senderName, timestamp, groupId }]
export async function uploadImages(items, groupNameById, selectedGroupIds) {
  const parentId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  if (!parentId) {
    throw new Error('GOOGLE_DRIVE_PARENT_FOLDER_ID is not set in .env');
  }

  if (!items.length) {
    return {
      uploaded: 0,
      bySender: {},
      byGroup: {},
      folderName: null,
      folderUrl: null,
      groups: selectedGroupIds.map((id) => groupNameById[id] || id),
    };
  }

  const folderName = dateFolderName(new Date());
  const folderId = await getOrCreateDateFolder(folderName, parentId);

  const bySender = {};
  const byGroup = {};
  const usedNames = new Set();

  for (const item of items) {
    const senderName = sanitize(item.senderName);
    let fileName = `${senderName}_${timeSuffix(new Date(item.timestamp))}.${item.ext}`;
    let attempt = 1;
    while (usedNames.has(fileName)) {
      attempt += 1;
      fileName = `${senderName}_${timeSuffix(new Date(item.timestamp))}-${attempt}.${item.ext}`;
    }
    usedNames.add(fileName);

    await uploadBuffer(item.buffer, fileName, item.mimeType, folderId);
    bySender[senderName] = (bySender[senderName] || 0) + 1;

    const groupName = groupNameById[item.groupId] || item.groupId;
    byGroup[groupName] = (byGroup[groupName] || 0) + 1;
  }

  return {
    uploaded: items.length,
    bySender,
    byGroup,
    folderName,
    folderUrl: folderUrl(folderId),
    groups: selectedGroupIds.map((id) => groupNameById[id] || id),
  };
}
