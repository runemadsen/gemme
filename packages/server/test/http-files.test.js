import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

async function login(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
}

test('upload requires authentication', async () => {
  const app = await startTestApp();
  try {
    const res = await app.upload('/api/files', { filename: 'x.txt', body: 'hi' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('upload creates an file, then it is listable, gettable, downloadable', async () => {
  const app = await startTestApp();
  try {
    await login(app);

    const up = await app.upload('/api/files', {
      filename: 'hello.txt',
      contentType: 'text/plain',
      body: 'hello world',
    });
    assert.equal(up.status, 201);
    const file = up.json.file;
    assert.equal(file.original_filename, 'hello.txt');
    assert.equal(file.content_hash != null, true);

    // list
    const list = await app.get('/api/files');
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].id, file.id);

    // get
    const got = await app.get(`/api/files/${file.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.file.id, file.id);

    // download current bytes
    const dl = await app.get(`/api/files/${file.id}/download`);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, 'hello world');
    assert.equal(dl.res.headers.get('content-type'), 'text/plain');
  } finally {
    await app.close();
  }
});

test('re-uploading the same name with different content makes a new file', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const v1 = (await app.upload('/api/files', { filename: 'doc.md', body: 'v1' })).json.file;
    const v2 = (await app.upload('/api/files', { filename: 'doc.md', body: 'v2 content' })).json.file;

    // A "new version" is simply a new file — distinct ids, both downloadable.
    assert.notEqual(v2.id, v1.id);
    assert.equal((await app.get(`/api/files/${v1.id}/download`)).text, 'v1');
    assert.equal((await app.get(`/api/files/${v2.id}/download`)).text, 'v2 content');
  } finally {
    await app.close();
  }
});

test('same content under different names dedups the blob but makes distinct files', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    // Different filenames -> not a duplicate, so both import; blob is shared.
    const a = (await app.upload('/api/files', { filename: 'one.bin', body: 'DUP' })).json.file;
    const b = (await app.upload('/api/files', { filename: 'two.bin', body: 'DUP' })).json.file;
    assert.notEqual(a.id, b.id);
    assert.equal(a.content_hash, b.content_hash);
  } finally {
    await app.close();
  }
});

test('soft-deleted file is gone from list and get (single-id array)', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const a = (await app.upload('/api/files', { filename: 'z.txt', body: 'z' })).json.file;
    assert.equal((await app.del('/api/files', { body: { fileIds: [a.id] } })).status, 200);
    assert.equal((await app.get(`/api/files/${a.id}`)).status, 404);
    assert.equal((await app.get('/api/files')).json.total, 0);
  } finally {
    await app.close();
  }
});

test('bulk delete: many files in one request', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const ids = [];
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      ids.push((await app.upload('/api/files', { filename: name, body: name })).json.file.id);
    }
    assert.equal((await app.get('/api/files')).json.total, 3);

    const del = await app.del('/api/files', { body: { fileIds: [ids[0], ids[1]] } });
    assert.equal(del.status, 200);
    assert.equal(del.json.count, 2);
    assert.equal((await app.get('/api/files')).json.total, 1);

    // Empty / missing fileIds is a 400.
    assert.equal((await app.del('/api/files', { body: { fileIds: [] } })).status, 400);
  } finally {
    await app.close();
  }
});

test('missing filename header is rejected', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const cookie = (
      await fetch(`${app.base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'r@example.com', password: 'supersecret' }),
      })
    ).headers
      .getSetCookie()[0]
      .split(';')[0];

    const res = await fetch(`${app.base}/api/files`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'data',
    });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});
