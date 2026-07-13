import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/auth/users.js';
import { enqueueExtraction, runPending } from '../src/worker/index.js';
import { fakeRegistry } from './helpers/plugins.js';
import { BlobStore } from '../src/storage/blobs.js';

// Verifies the upload -> onVersionCreated -> enqueue -> extract path end to end
// through the HTTP layer (guards the startServer/createApp wiring).
test('uploading enqueues extraction and metadata becomes searchable', async () => {
  const enqueued = [];
  const app = await startTestApp({
    onVersionCreated: (versionId) => {
      enqueued.push(versionId);
      enqueueExtraction(app.db, versionId);
    },
  });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const up = await app.upload('/api/assets', {
      filename: 'trip.md',
      contentType: 'text/markdown',
      body: '# Trip\nmountain sky river',
    });
    const versionId = up.json.asset.current_version_id;
    assert.deepEqual(enqueued, [versionId], 'onVersionCreated fired with the new version id');

    // Status starts pending (usable immediately, metadata fills in later)
    assert.equal(up.json.asset.versions[0].extraction_status, 'pending');

    // Drain the queue (what the background worker does on its tick)
    const ctx = { blobStore: new BlobStore(app.dataDir), registry: fakeRegistry() };
    await runPending(app.db, ctx);

    // Now extracted: status done, and the body is full-text searchable
    const status = app.db.prepare('SELECT extraction_status FROM versions WHERE id = ?').get(versionId);
    assert.equal(status.extraction_status, 'done');

    const hit = app.db
      .prepare('SELECT version_id FROM metadata_fts WHERE metadata_fts MATCH ?')
      .get('mountain');
    assert.equal(hit.version_id, versionId);
  } finally {
    await app.close();
  }
});
