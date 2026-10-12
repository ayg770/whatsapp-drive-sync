import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccessUsers } from '../src/access.js';
test('malformed credential configuration does not disclose its contents', () => {
  const original = process.env.ACCESS_USERS_JSON;
  process.env.ACCESS_USERS_JSON = 'secret-value-that-must-not-be-logged';
  try {
    assert.throws(
      () => readAccessUsers(),
      (err) => err.message === 'ACCESS_USERS_JSON must be valid JSON'
    );
  } finally {
    if (original === undefined) delete process.env.ACCESS_USERS_JSON;
    else process.env.ACCESS_USERS_JSON = original;
  }
});
