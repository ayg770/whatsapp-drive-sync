import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageUploader, runImageJob, imageFileName, imageKey } from '../src/sync.js';
import { senderName, messageIdentity, isGroupImageMessage } from '../src/waUtils.js';

const image = (id = 'one') => ({
  groupId: 'group@g.us',
  messageId: id,
  senderName: 'שרה לוי',
  groupName: 'School',
  timestamp: 1700000000000,
  ext: 'jpg',
  mimeType: 'image/jpeg'
});
function fakeDrive() {
  const uploaded = new Map();
  const calls = [];
  return {
    uploaded,
    calls,
    deps: {
      reserve: async (key) => key,
      find: async (key) => uploaded.get(key),
      folder: async () => 'folder',
      upload: async (buffer, name, type, folder, key) => {
        calls.push({ buffer, name, key });
        uploaded.set(key, { id: key });
      }
    }
  };
}
test('two sessions uploading the same group message download and upload only once', async () => {
  const drive = fakeDrive();
  let downloads = 0;
  const first = createImageUploader('parent', drive.deps);
  const second = createImageUploader('parent', drive.deps);
  const download = async () => {
    downloads++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Buffer.from('photo');
  };
  const results = await Promise.all([first(image(), download), second(image(), download)]);
  assert.equal(downloads, 1);
  assert.equal(drive.calls.length, 1);
  assert.equal(results.filter((r) => r.skipped).length, 1);
});
test('Drive markers survive a new uploader and uncertain upload response', async () => {
  const drive = fakeDrive();
  const original = drive.deps.upload;
  drive.deps.upload = async (...args) => {
    await original(...args);
    throw Error('response lost');
  };
  await assert.rejects(
    createImageUploader('parent', drive.deps)(image(), async () => Buffer.from('photo'))
  );
  const result = await createImageUploader('parent', drive.deps)(image(), () => {
    throw Error('must not download');
  });
  assert.equal(result.skipped, true);
  assert.equal(drive.calls.length, 1);
});
test('failed download stays retryable, job continues, and counts describe outcomes', async () => {
  const drive = fakeDrive();
  const upload = createImageUploader('parent', drive.deps);
  const snapshots = [];
  const items = [image('bad'), image('good')];
  const result = await runImageJob(
    items,
    (item) =>
      upload(item, async () => {
        if (item.messageId === 'bad') throw Error('expired media');
        return Buffer.from('photo');
      }),
    { progress: (p) => snapshots.push(p) }
  );
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(drive.uploaded.has(imageKey('parent', 'group@g.us', 'bad')), false);
  assert.equal(snapshots[0].remaining, 1);
  const retry = await runImageJob(items, (item) => upload(item, async () => Buffer.from('photo')));
  assert.equal(retry.uploaded, 1);
  assert.equal(retry.skipped, 1);
  assert.equal(retry.failed, 0);
});
test('failed upload does not mark success and does not prevent other uploads', async () => {
  const drive = fakeDrive();
  const original = drive.deps.upload;
  drive.deps.upload = async (...args) => {
    if (args[4] === imageKey('parent', 'group@g.us', 'bad')) throw Error('quota');
    await original(...args);
  };
  const uploader = createImageUploader('parent', drive.deps);
  const result = await runImageJob([image('bad'), image('good')], (item) =>
    uploader(item, async () => Buffer.from('photo'))
  );
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);
  assert.equal(drive.uploaded.size, 1);
});
test('job processes photos incrementally and honors cancellation between photos', async () => {
  let active = true;
  let calls = 0;
  const result = await runImageJob(
    [image('a'), image('b')],
    async () => {
      calls++;
      active = false;
      return {};
    },
    { active: () => active }
  );
  assert.equal(calls, 1);
  assert.equal(result.remaining, 1);
});
test('names preserve Hebrew sender and distinguish same-second photos across groups and jobs', () => {
  assert.match(imageFileName(image()), /^שרה לוי_/);
  assert.notEqual(imageFileName(image('a')), imageFileName(image('b')));
  assert.notEqual(imageFileName(image()), imageFileName({ ...image(), groupId: 'other@g.us' }));
  assert.doesNotMatch(imageFileName({ ...image(), senderName: 'a/b\u0000' }), /[\/\u0000]/);
});
test('sender is original message author, with contact and stable participant fallbacks', () => {
  const message = {
    key: { participant: '123:2@s.whatsapp.net' },
    pushName: 'שרה'
  };
  assert.equal(
    senderName(message, new Map([['123:2@s.whatsapp.net', 'Contact']]), 'Visitor'),
    'שרה'
  );
  delete message.pushName;
  assert.equal(
    senderName(message, new Map([['123:2@s.whatsapp.net', 'Contact']]), 'Visitor'),
    'Contact'
  );
  assert.equal(senderName(message, new Map(), 'Visitor'), 'שולח 123');
  assert.equal(senderName({ key: {} }, new Map(), 'Visitor'), 'שולח לא מזוהה');
});
test('images sent by syncing user are included and message IDs are scoped to group', () => {
  const msg = {
    key: { remoteJid: 'group@g.us', id: 'same', fromMe: true },
    message: {
      ephemeralMessage: {
        message: { imageMessage: { mimetype: 'image/jpeg' } }
      }
    }
  };
  assert.equal(isGroupImageMessage(msg), true);
  assert.notEqual(
    messageIdentity(msg),
    messageIdentity({ ...msg, key: { ...msg.key, remoteJid: 'other@g.us' } })
  );
});

test('retry keeps the same Drive file ID while a previous upload is not indexed', async () => {
  const reserved = new Map();
  const attempts = [];
  let first = true;
  const deps = {
    find: async () => null,
    folder: async () => 'folder',
    reserve: async (key) => {
      if (!reserved.has(key)) reserved.set(key, 'reserved-' + key);
      return reserved.get(key);
    },
    upload: async (buffer, name, type, folder, key, id) => {
      attempts.push(id);
      if (first) {
        first = false;
        throw Error('timeout');
      }
    }
  };
  await assert.rejects(
    createImageUploader('parent', deps)(image(), async () => Buffer.from('photo'))
  );
  await createImageUploader('parent', deps)(image(), async () => Buffer.from('photo'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
});

test('contact sender lookup normalizes device suffixes', () => {
  assert.equal(
    senderName(
      { key: { participant: '123:7@s.whatsapp.net' } },
      new Map([['123@s.whatsapp.net', 'שרה']]),
      'Visitor'
    ),
    'שרה'
  );
});
