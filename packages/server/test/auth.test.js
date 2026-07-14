import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../src/lib/db/index.js';
import { hashPassword, verifyPassword } from '../src/lib/auth/passwords.js';
import { createUser, authenticateUser, getUserByEmail, countUsers } from '../src/lib/auth/users.js';
import {
  createSession,
  getSessionUser,
  deleteSession,
  parseCookies,
  serializeSessionCookie,
} from '../src/lib/auth/sessions.js';

test('password hashing verifies correct and rejects wrong password', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('verifyPassword rejects malformed stored hash', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('createUser stores a user and normalizes email', async () => {
  const db = openMemoryDatabase();
  const user = await createUser(db, { email: '  R@Example.COM ', name: 'Rune', password: 'pw123456' });
  assert.equal(user.email, 'r@example.com');
  assert.equal(user.name, 'Rune');
  assert.ok(!('password_hash' in user), 'public user omits password_hash');
  assert.equal(countUsers(db), 1);
  db.close();
});

test('duplicate email is rejected', async () => {
  const db = openMemoryDatabase();
  await createUser(db, { email: 'a@b.com', password: 'pw123456' });
  await assert.rejects(() => createUser(db, { email: 'a@b.com', password: 'other' }), /already exists/);
  db.close();
});

test('authenticateUser returns the user on valid creds, null otherwise', async () => {
  const db = openMemoryDatabase();
  await createUser(db, { email: 'a@b.com', password: 'secretpw' });
  assert.equal(await authenticateUser(db, 'a@b.com', 'nope'), null);
  assert.equal(await authenticateUser(db, 'missing@b.com', 'secretpw'), null);
  const ok = await authenticateUser(db, 'A@B.com', 'secretpw');
  assert.equal(ok.email, 'a@b.com');
  db.close();
});

test('sessions resolve to their user and can be deleted', async () => {
  const db = openMemoryDatabase();
  const user = await createUser(db, { email: 'a@b.com', password: 'secretpw' });
  const token = createSession(db, user.id);
  assert.equal(getSessionUser(db, token).id, user.id);
  deleteSession(db, token);
  assert.equal(getSessionUser(db, token), null);
  assert.equal(getSessionUser(db, 'bogus'), null);
  db.close();
});

test('expired sessions do not resolve', async () => {
  const db = openMemoryDatabase();
  const user = await createUser(db, { email: 'a@b.com', password: 'secretpw' });
  const token = createSession(db, user.id, -1000); // already expired
  assert.equal(getSessionUser(db, token), null);
  db.close();
});

test('cookie parse and serialize round-trip', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  const cookie = serializeSessionCookie('tok123');
  assert.match(cookie, /gemme_session=tok123/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});
