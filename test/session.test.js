import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../src/sessionManager.js';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function harness(t, overrides = {}) {
  const ev = new EventEmitter();
  const sock = {
    ev,
    authState: {
      creds: {
        registered: true,
        me: { id: '123:4@s.whatsapp.net', name: 'Visitor' }
      }
    },
    groupFetchAllParticipating: async () => ({
      first: { id: 'first@g.us', subject: 'First' },
      second: { id: 'second@g.us', subject: 'Second' }
    }),
    logout: async () => {
      ev.emit('connection.update', { connection: 'close' });
    },
    end: () => {},
    updateMediaMessage: () => {}
  };
  let connections = 0;
  let removed = 0;
  const manager = createSessionManager({
    makeSocket: () => {
      connections++;
      return sock;
    },
    loadAuth: async () => ({ state: {}, saveCreds: async () => {} }),
    protocolVersion: async () => ({ version: [1, 2, 3] }),
    authDir: () => '/tmp/mock-session',
    removeAuthDir: () => {
      removed++;
    },
    uploadedBefore: () => false,
    checkpoint: () => {},
    download: async () => Buffer.from('photo'),
    uploader: () => async (item, download) => {
      await download();
      return { uploaded: true };
    },
    ...overrides
  });
  const id = manager.createSession();
  await tick();
  ev.emit('connection.update', { connection: 'open' });
  await tick();
  t.after(() => manager.closeSession(id));
  return {
    manager,
    id,
    sock,
    ev,
    get connections() {
      return connections;
    },
    get removed() {
      return removed;
    }
  };
}
function photo(id, group = 'first@g.us') {
  return {
    key: { id, remoteJid: group, participant: '456@s.whatsapp.net' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'שרה',
    message: { imageMessage: { mimetype: 'image/jpeg' } }
  };
}
test('groups load without waiting for history; late activity reorders them; older chat updates do not regress order', async (t) => {
  const { manager, id, ev } = await harness(t);
  assert.equal(manager.getPublicState(id).status, 'connected');
  assert.equal(manager.getPublicState(id).historyComplete, false);
  ev.emit('messages.upsert', { messages: [photo('one', 'second@g.us')] });
  ev.emit('chats.update', [{ id: 'second@g.us', conversationTimestamp: 1 }]);
  assert.equal(manager.getPublicState(id).groups[0].id, 'second@g.us');
  assert.ok(manager.getPublicState(id).groups[0].lastActivity > 1000);
});
test('background session job returns immediately, rejects concurrent job, releases state after failed download', async (t) => {
  const old = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = 'fake-parent';
  t.after(() => {
    if (old === undefined) delete process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = old;
  });
  let release;
  const blocking = new Promise((resolve) => {
    release = resolve;
  });
  const { manager, id, ev } = await harness(t, {
    download: async () => {
      await blocking;
      throw Error('download failed');
    }
  });
  ev.emit('messages.upsert', { messages: [photo('bad'), photo('good')] });
  assert.throws(() => manager.syncSession(id, ['unavailable@g.us'], 7));
  const started = manager.syncSession(id, ['first@g.us'], 7);
  assert.ok(started.jobId);
  assert.equal(manager.getPublicState(id).status, 'syncing');
  assert.throws(() => manager.syncSession(id, ['first@g.us'], 7));
  release();
  await tick();
  await tick();
  const state = manager.getPublicState(id);
  assert.equal(state.status, 'connected');
  assert.equal(state.summary.failed, 2);
  assert.equal(state.summary.remaining, 0);
});
test('logout close event cannot reconnect and session data is removed', async (t) => {
  const h = await harness(t);
  const result = await h.manager.closeSession(h.id, { logout: true });
  await tick();
  assert.equal(result.loggedOut, true);
  assert.equal(h.connections, 1);
  assert.equal(h.removed, 1);
  assert.equal(h.manager.getPublicState(h.id), null);
});
test('pending authentication cannot create a socket after session closed', async (t) => {
  let release;
  const auth = new Promise((resolve) => {
    release = resolve;
  });
  let sockets = 0;
  const manager = createSessionManager({
    makeSocket: () => {
      sockets++;
    },
    authDir: () => '/tmp/mock',
    removeAuthDir: () => {},
    loadAuth: () => auth,
    protocolVersion: async () => ({ version: [1, 2, 3] })
  });
  const id = manager.createSession();
  await manager.closeSession(id);
  release({ state: {}, saveCreds: async () => {} });
  await tick();
  assert.equal(sockets, 0);
});

test('contact aliases include anonymous LID and normalized phone JID', async (t) => {
  const old = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
  process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = 'fake-parent';
  t.after(() => {
    if (old === undefined) delete process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = old;
  });
  const names = [];
  const { manager, id, ev } = await harness(t, {
    uploader: () => async (item) => {
      names.push(item.senderName);
      return {};
    }
  });
  ev.emit('contacts.upsert', [
    { id: '456@s.whatsapp.net', lid: '999@lid', jid: '456@s.whatsapp.net', name: 'שרה' }
  ]);
  const msg = photo('named');
  delete msg.pushName;
  msg.key.participant = '999@lid';
  ev.emit('messages.upsert', { messages: [msg] });
  manager.syncSession(id, ['first@g.us'], 7);
  await tick();
  await tick();
  assert.deepEqual(names, ['שרה']);
});
