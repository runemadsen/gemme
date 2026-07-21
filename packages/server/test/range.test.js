import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

const BODY = 'HELLO WORLD RANGE TEST'; // 22 bytes

async function login(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
}

test('download supports Range (206) and advertises Accept-Ranges', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const id = (await app.upload('/api/files', { filename: 'a.bin', contentType: 'application/octet-stream', body: BODY })).json.file.id;

    // Full request → 200 + Accept-Ranges.
    const full = await app.get(`/api/files/${id}/download`);
    assert.equal(full.status, 200);
    assert.equal(full.res.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.text, BODY);

    // Partial → 206 with the right slice + Content-Range.
    const part = await app.get(`/api/files/${id}/download`, { headers: { range: 'bytes=0-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.res.headers.get('content-range'), `bytes 0-4/${BODY.length}`);
    assert.equal(part.res.headers.get('content-length'), '5');
    assert.equal(part.text, 'HELLO');

    // Open-ended range to EOF (byte 18 onward = 'TEST').
    const tail = await app.get(`/api/files/${id}/download`, { headers: { range: 'bytes=18-' } });
    assert.equal(tail.status, 206);
    assert.equal(tail.res.headers.get('content-range'), `bytes 18-${BODY.length - 1}/${BODY.length}`);
    assert.equal(tail.text, 'TEST');

    // Unsatisfiable → 416.
    const bad = await app.get(`/api/files/${id}/download`, { headers: { range: 'bytes=999-1000' } });
    assert.equal(bad.status, 416);
  } finally {
    await app.close();
  }
});

test('public /i/:id supports Range', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    const id = (await app.upload('/api/files', { filename: 'a.bin', contentType: 'application/octet-stream', body: BODY })).json.file.id;
    const col = (await app.post('/api/collections', { name: 'Pub' })).json.collection;
    await app.post(`/api/collections/${col.id}/files`, { fileIds: [id] });
    await app.req('PATCH', `/api/collections/${col.id}`, { body: { visibility: 'public' } });

    const res = await fetch(`${app.base}/i/${id}`, { headers: { range: 'bytes=6-10' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 6-10/${BODY.length}`);
    assert.equal(await res.text(), 'WORLD');
  } finally {
    await app.close();
  }
});
