import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';
import { BlobStore } from '../src/lib/storage/blobs.js';
import { DerivedStore } from '../src/lib/storage/derived.js';
import { runPending } from '../src/worker/index.js';
import { enqueueExtraction } from '../src/worker/queue.js';
import { fakeRegistry } from './helpers/plugins.js';

// The detail-page preview is produced by the matching plugin's `preview`
// capability — the core injects the HTML and never branches on file type.

async function login(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
}
async function drain(app) {
  await runPending(app.db, {
    blobStore: new BlobStore(app.dataDir),
    derivedStore: new DerivedStore(app.dataDir),
    registry: fakeRegistry(),
  });
}

test('image detail preview comes from the image plugin (<img> to download)', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await login(app);
    const id = (await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' })).json.file.id;
    const res = await app.get(`/files/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`<img src="/api/files/${id}/download"`));
  } finally {
    await app.close();
  }
});

test('video detail preview comes from the video plugin (<video data-hls>)', async () => {
  const app = await startTestApp({ onFileCreated: (id) => enqueueExtraction(app.db, id) });
  try {
    await login(app);
    const id = (await app.upload('/api/files', { filename: 'clip.mp4', contentType: 'video/mp4', body: 'FAKEVIDEO' })).json.file.id;
    await drain(app);
    const res = await app.get(`/files/${id}`);
    assert.match(res.text, new RegExp(`data-hls="/api/files/${id}/master.m3u8"`));
  } finally {
    await app.close();
  }
});

test('a file with no matching preview plugin renders an empty preview slot', async () => {
  const app = await startTestApp();
  try {
    await login(app);
    // text plugin has no `preview` capability → the preview div is empty.
    const id = (await app.upload('/api/files', { filename: 'a.txt', contentType: 'text/plain', body: 'hi' })).json.file.id;
    const res = await app.get(`/files/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /<div class="preview"><\/div>/);
  } finally {
    await app.close();
  }
});
