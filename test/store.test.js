import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const store = new URL('../src/store.js', import.meta.url).href;
function run(dir, code) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as store from ${JSON.stringify(store)}; ${code}`],
    { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', stdio: 'pipe' }
  );
}
test('reserved IDs and successful message checkpoints survive process restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  run(dir, `store.reserveImageId('key','drive-id');store.markImageUploaded('group','message');`);
  const result = JSON.parse(
    run(
      dir,
      `console.log(JSON.stringify([store.getReservedImageId('key'),store.wasImageUploaded('group','message'),store.wasImageUploaded('group','failed')]));`
    )
  );
  assert.deepEqual(result, ['drive-id', true, false]);
  assert.equal(fs.statSync(path.join(dir, 'drive-image-ids.json')).mode & 0o777, 0o600);
});
test('corrupt state fails closed instead of silently forgetting uploaded images', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'uploaded-images.json'), 'invalid-json');
  assert.throws(
    () => run(dir, `store.wasImageUploaded('group','message');`),
    /Persistent sync state could not be read/
  );
});
