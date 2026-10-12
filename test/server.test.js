import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
const users = {
  admin: { password: 'admin-password-long', admin: true },
  staff: { password: 'staff-password-long' },
  other: { password: 'other-password-long' }
};
const auth = (user) => ({
  authorization: 'Basic ' + Buffer.from(user + ':' + users[user].password).toString('base64')
});
async function harness(t) {
  const states = new Map();
  let counter = 0;
  const manager = {
    createSession: () => {
      const id = String(++counter);
      states.set(id, { status: 'connected', groups: [] });
      return id;
    },
    getPublicState: (id) => states.get(id),
    syncSession: (id) => {
      states.set(id, {
        status: 'syncing',
        progress: { found: 2, remaining: 2 }
      });
      return { jobId: 'job' };
    },
    closeSession: async (id) => states.delete(id)
  };
  const server = createApp({ manager, users }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { request: (url, options = {}) => fetch(base + url, options), states };
}
test('private page requires login; health check works; regular user cannot reach OAuth', async (t) => {
  const { request } = await harness(t);
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/healthz')).status, 200);
  const page = await request('/', { headers: auth('staff') });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /historyHint/);
  assert.equal((await request('/admin/google-auth/start', { headers: auth('staff') })).status, 403);
  assert.equal(
    (
      await request('/admin/google-auth/callback?code=secret&state=bad', {
        headers: auth('admin')
      })
    ).status,
    400
  );
});
test('job is accepted immediately; status poll exposes progress; sessions belong to their user', async (t) => {
  const { request } = await harness(t);
  const res = await request('/api/session', {
    method: 'POST',
    headers: auth('staff')
  });
  const { sessionId } = await res.json();
  assert.equal(
    (await request('/api/session/' + sessionId, { headers: auth('other') })).status,
    404
  );
  const started = await request('/api/session/' + sessionId + '/sync', {
    method: 'POST',
    headers: { ...auth('staff'), 'content-type': 'application/json' },
    body: JSON.stringify({ groupIds: ['x'], lookbackDays: 7 })
  });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { jobId: 'job' });
  const state = await (
    await request('/api/session/' + sessionId, { headers: auth('staff') })
  ).json();
  assert.equal(state.progress.remaining, 2);
  assert.equal(
    (
      await request('/api/session/' + sessionId + '/close', {
        method: 'POST',
        headers: auth('staff')
      })
    ).status,
    200
  );
  assert.equal(
    (await request('/api/session/' + sessionId, { headers: auth('staff') })).status,
    404
  );
});
test('cross-site mutations and malformed phone numbers are rejected', async (t) => {
  const { request } = await harness(t);
  assert.equal(
    (
      await request('/api/session', {
        method: 'POST',
        headers: { ...auth('staff'), 'sec-fetch-site': 'cross-site' }
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request('/api/session', {
        method: 'POST',
        headers: { ...auth('staff'), 'content-type': 'application/json' },
        body: '{"phoneNumber":"abc"}'
      })
    ).status,
    400
  );
});
test('production fails closed without configured users', async (t) => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const server = createApp({ users: null }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    assert.equal((await fetch('http://127.0.0.1:' + server.address().port)).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});
