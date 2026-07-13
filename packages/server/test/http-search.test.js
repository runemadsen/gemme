import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';
import { enqueueExtraction, runPending } from '../src/worker/index.js';
import { fakeRegistry } from './helpers/plugins.js';
import { BlobStore } from '../src/lib/storage/blobs.js';

test('filename is searchable immediately, before extraction runs', async () => {
  const app = await startTestApp(); // no worker wired → extraction never runs here
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    await app.upload('/api/assets', { filename: 'DSC01234.JPG', contentType: 'image/jpeg', body: 'x' });

    // Not yet extracted...
    const list = await app.get('/api/assets');
    assert.equal(list.json.items[0].extraction_status, 'pending');

    // ...but already findable by filename and type.
    assert.equal((await app.get('/api/search?q=DSC')).json.total, 1);
    assert.equal((await app.get('/api/search?q=' + encodeURIComponent('type:image'))).json.total, 1);
  } finally {
    await app.close();
  }
});

test('search endpoint paginates and sorts with meta', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    for (const n of ['b.txt', 'a.txt', 'c.txt'])
      await app.upload('/api/assets', { filename: n, contentType: 'text/plain', body: n });

    const res = await app.get('/api/search?sort=name&direction=asc&page=2&perPage=1');
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 3);
    assert.equal(res.json.pages, 3);
    assert.equal(res.json.page, 2);
    assert.equal(res.json.perPage, 1);
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].original_filename, 'b.txt'); // a, [b], c
  } finally {
    await app.close();
  }
});

test('search endpoint filters uploaded-and-extracted assets', async () => {
  const app = await startTestApp({
    onVersionCreated: (versionId) => enqueueExtraction(app.db, versionId),
  });
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    await app.upload('/api/assets', { filename: 'trip.md', contentType: 'text/markdown', body: 'mountain sky' });
    await app.upload('/api/assets', { filename: 'note.txt', contentType: 'text/plain', body: 'grocery list' });

    // process the extraction queue
    await runPending(app.db, { blobStore: new BlobStore(app.dataDir), registry: fakeRegistry() });

    const byText = await app.get('/api/search?q=mountain');
    assert.equal(byText.status, 200);
    assert.equal(byText.json.total, 1);
    assert.equal(byText.json.items[0].original_filename, 'trip.md');

    const byType = await app.get('/api/search?q=' + encodeURIComponent('type:text'));
    assert.equal(byType.json.total, 2);

    // bad query -> 400
    const bad = await app.get('/api/search?q=' + encodeURIComponent('type>image'));
    assert.equal(bad.status, 400);

    // search requires auth
    app.clearCookie();
    assert.equal((await app.get('/api/search?q=mountain')).status, 401);
  } finally {
    await app.close();
  }
});
