import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadBuffer } from '../src/driveClient.js';
test('upload uses reserved ID, stores deduplication marker, and disables automatic create retry', async () => {
  let request, options;
  const drive = {
    files: {
      create: async (req, opts) => {
        request = req;
        options = opts;
        return { data: { id: 'reserved' } };
      }
    }
  };
  await uploadBuffer(
    Buffer.from('photo'),
    'שרה.jpg',
    'image/jpeg',
    'folder',
    'message-key',
    'reserved',
    drive
  );
  assert.equal(request.requestBody.id, 'reserved');
  assert.deepEqual(request.requestBody.appProperties, {
    imageKey: 'message-key'
  });
  assert.equal(options.retry, false);
  assert.equal(options.timeout, 60000);
});
test('already created reserved ID is accepted only when marker matches', async () => {
  const drive = {
    files: {
      create: async () => {
        throw Object.assign(Error('conflict'), { code: 409 });
      },
      get: async () => ({
        data: { id: 'reserved', appProperties: { imageKey: 'key' } }
      })
    }
  };
  assert.equal(
    (
      await uploadBuffer(
        Buffer.from('photo'),
        'file.jpg',
        'image/jpeg',
        'folder',
        'key',
        'reserved',
        drive
      )
    ).id,
    'reserved'
  );
  drive.files.get = async () => ({
    data: { id: 'reserved', appProperties: { imageKey: 'wrong' } }
  });
  await assert.rejects(
    uploadBuffer(
      Buffer.from('photo'),
      'file.jpg',
      'image/jpeg',
      'folder',
      'key',
      'reserved',
      drive
    ),
    /conflict/
  );
});
