import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/auth/users.js';

async function login(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
}

test('upload requires authentication', async () => {
  const app = await startTestApp();
  try {
    const res = await app.upload('/api/assets', { filename: 'x.txt', body: 'hi' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('upload creates an asset, then it is listable, gettable, downloadable', async () => {
  const app = await startTestApp();
  try {
    await login(app);

    const up = await app.upload('/api/assets', {
      filename: 'hello.txt',
      contentType: 'text/plain',
      body: 'hello world',
    });
    assert.equal(up.status, 201);
    const asset = up.json.asset;
    assert.equal(asset.original_filename, 'hello.txt');
    assert.equal(asset.versions.length, 1);

    // list
    const list = await app.get('/api/assets');
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].id, asset.id);

    // get
    const got = await app.get(`/api/assets/${asset.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.asset.id, asset.id);

    // download current bytes
    const dl = await app.get(`/api/assets/${asset.id}/download`);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, 'hello world');
    assert.equal(dl.res.headers.get('content-type'), 'text/plain');
  } finally {
    await app.close();
  }
});

test('adding a version updates current; old version still downloadable', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const v1 = (await app.upload('/api/assets', { filename: 'doc.md', body: 'v1' })).json.asset;
    const firstVersionId = v1.current_version_id;

    const v2 = (await app.upload(`/api/assets/${v1.id}/versions`, { filename: 'doc.md', body: 'v2 content' }))
      .json.asset;
    assert.equal(v2.versions.length, 2);
    assert.notEqual(v2.current_version_id, firstVersionId);

    // current download returns v2
    assert.equal((await app.get(`/api/assets/${v1.id}/download`)).text, 'v2 content');
    // old version still retrievable
    assert.equal(
      (await app.get(`/api/assets/${v1.id}/versions/${firstVersionId}/download`)).text,
      'v1'
    );
  } finally {
    await app.close();
  }
});

test('identical uploads dedup at the blob layer but are distinct assets', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const a = (await app.upload('/api/assets', { filename: 'same.bin', body: 'DUP' })).json.asset;
    const b = (await app.upload('/api/assets', { filename: 'same.bin', body: 'DUP' })).json.asset;
    assert.notEqual(a.id, b.id);
    assert.equal(a.versions[0].content_hash, b.versions[0].content_hash);
  } finally {
    await app.close();
  }
});

test('soft-deleted asset is gone from list and get', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const a = (await app.upload('/api/assets', { filename: 'z.txt', body: 'z' })).json.asset;
    assert.equal((await app.del(`/api/assets/${a.id}`)).status, 200);
    assert.equal((await app.get(`/api/assets/${a.id}`)).status, 404);
    assert.equal((await app.get('/api/assets')).json.total, 0);
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

    const res = await fetch(`${app.base}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie },
      body: 'data',
    });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});
