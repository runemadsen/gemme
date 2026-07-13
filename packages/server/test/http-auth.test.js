import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/auth/users.js';

test('health endpoint responds ok', async () => {
  const app = await startTestApp();
  try {
    const { status, json } = await app.get('/health');
    assert.equal(status, 200);
    assert.equal(json.status, 'ok');
  } finally {
    await app.close();
  }
});

test('login → me → logout flow', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', name: 'Rune', password: 'supersecret' });

    // Unauthenticated /me is 401
    assert.equal((await app.get('/api/me')).status, 401);

    // Wrong password 401
    assert.equal((await app.post('/api/login', { email: 'r@example.com', password: 'nope' })).status, 401);

    // Correct login sets a cookie
    const login = await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.email, 'r@example.com');

    // /me now works (cookie carried by the jar)
    const me = await app.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, 'r@example.com');

    // Logout, then /me is 401 again
    assert.equal((await app.post('/api/logout')).status, 200);
    assert.equal((await app.get('/api/me')).status, 401);
  } finally {
    await app.close();
  }
});

test('unknown route is 404, wrong method is 405', async () => {
  const app = await startTestApp();
  try {
    assert.equal((await app.get('/api/nope')).status, 404);
    assert.equal((await app.get('/api/login')).status, 405); // login is POST-only
  } finally {
    await app.close();
  }
});
