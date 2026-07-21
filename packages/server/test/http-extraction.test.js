import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';
import { enqueueExtraction, runPending } from '../src/worker/index.js';
import { fakeRegistry } from './helpers/plugins.js';
import { BlobStore } from '../src/lib/storage/blobs.js';

// Verifies the upload -> onFileCreated -> enqueue -> extract path end to end
// through the HTTP layer (guards the startServer/createApp wiring).
test('uploading enqueues extraction and metadata becomes searchable', async () => {
  const enqueued = [];
  const app = await startTestApp({
    onFileCreated: (fileId) => {
      enqueued.push(fileId);
      enqueueExtraction(app.db, fileId);
    },
  });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    const up = await app.upload('/api/files', {
      filename: 'trip.md',
      contentType: 'text/markdown',
      body: '# Trip\nmountain sky river',
    });
    const fileId = up.json.file.id;
    assert.deepEqual(enqueued, [fileId], 'onFileCreated fired with the new file id');

    // Status starts pending (usable immediately, metadata fills in later)
    assert.equal(up.json.file.extraction_status, 'pending');

    // Drain the queue (what the background worker does on its tick)
    const ctx = { blobStore: new BlobStore(app.dataDir), registry: fakeRegistry() };
    await runPending(app.db, ctx);

    // Now extracted: status done, and the body is full-text searchable
    const status = app.db.prepare('SELECT extraction_status FROM files WHERE id = ?').get(fileId);
    assert.equal(status.extraction_status, 'done');

    const hit = app.db
      .prepare('SELECT file_id FROM metadata_fts WHERE metadata_fts MATCH ?')
      .get('mountain');
    assert.equal(hit.file_id, fileId);
  } finally {
    await app.close();
  }
});
