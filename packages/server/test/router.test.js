import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/server/router.js';

test('matches static and param routes and extracts params', () => {
  const r = new Router();
  const noop = () => {};
  r.get('/api/files', noop);
  r.get('/api/files/:id', noop);
  r.get('/api/files/:id/versions/:vid/download', noop);

  assert.deepEqual(r.match('GET', '/api/files').params, {});
  assert.deepEqual(r.match('GET', '/api/files/42').params, { id: '42' });
  assert.deepEqual(r.match('GET', '/api/files/42/versions/7/download').params, {
    id: '42',
    vid: '7',
  });
});

test('trailing slash tolerated; unknown path is null', () => {
  const r = new Router();
  r.get('/api/files/:id', () => {});
  assert.ok(r.match('GET', '/api/files/1/'));
  assert.equal(r.match('GET', '/nope'), null);
});

test('known path with wrong method reports methodNotAllowed', () => {
  const r = new Router();
  r.post('/api/login', () => {});
  const m = r.match('GET', '/api/login');
  assert.equal(m.methodNotAllowed, true);
});
