import crypto from 'node:crypto';
import {
  getOrCreateDateFolder,
  uploadBuffer,
  findUploadedImage,
  folderUrl,
  reserveDriveImageId
} from './driveClient.js';

// One server instance serializes each image across all visitor sessions.
const pending = new Map();
export async function withImageLock(key, work) {
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  pending.set(key, next);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (pending.get(key) === next) pending.delete(key);
  }
}
export function imageKey(parentId, groupId, messageId) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([parentId, groupId, messageId]))
    .digest('hex');
}
export function imageFileName(item) {
  const name =
    String(item.senderName || 'שולח לא מזוהה')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .trim()
      .slice(0, 120) || 'שולח לא מזוהה';
  const time = new Date(item.timestamp).toTimeString().slice(0, 8).replaceAll(':', '-');
  const suffix = imageKey('', item.groupId, item.messageId).slice(0, 16);
  return `${name}_${time}_${suffix}.${item.ext}`;
}
export function createImageUploader(parentId, deps = {}) {
  const find = deps.find || findUploadedImage;
  const folder = deps.folder || getOrCreateDateFolder;
  const upload = deps.upload || uploadBuffer;
  const reserve = deps.reserve || reserveDriveImageId;
  let folderPromise;
  const folderName = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  return async (item, download) => {
    const key = imageKey(parentId, item.groupId, item.messageId);
    return withImageLock(key, async () => {
      if (await find(key)) return { skipped: true };
      const buffer = await download();
      if (!folderPromise)
        folderPromise = withImageLock(`folder:${parentId}:${folderName}`, () =>
          folder(folderName, parentId)
        ).catch((err) => {
          folderPromise = null;
          throw err;
        });
      const folderId = await folderPromise;
      const id = await reserve(key);
      await upload(buffer, imageFileName(item), item.mimeType, folderId, key, id);
      return { uploaded: true, folderName, folderUrl: folderUrl(folderId) };
    });
  };
}

// Streaming work: at most one downloaded photo is retained per job.
export async function runImageJob(
  items,
  processImage,
  { progress, active = () => true, batchSize = 10 } = {}
) {
  const result = {
    found: items.length,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    remaining: items.length,
    bySender: Object.create(null),
    byGroup: Object.create(null),
    failures: []
  };
  for (let i = 0; i < items.length && active(); i++) {
    const item = items[i];
    try {
      const outcome = await processImage(item);
      if (outcome.skipped) result.skipped++;
      else {
        result.uploaded++;
        result.folderName = outcome.folderName;
        result.folderUrl = outcome.folderUrl;
        result.bySender[item.senderName] = (result.bySender[item.senderName] || 0) + 1;
        result.byGroup[item.groupName] = (result.byGroup[item.groupName] || 0) + 1;
      }
    } catch {
      result.failed++;
      // Never expose upstream request objects, tokens, or raw errors.
      result.failures.push({
        messageId: item.messageId,
        groupId: item.groupId
      });
    }
    result.remaining--;
    progress?.({ ...result, failures: undefined });
    if ((i + 1) % batchSize === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return result;
}
