import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

test('facets endpoint requires auth', async () => {
  const app = await startTestApp();
  try {
    assert.equal((await app.get('/api/facets?keys=ext')).status, 401);
  } finally {
    await app.close();
  }
});

test('facets endpoint returns extension + type facets from uploaded files', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    await app.upload('/api/files', { filename: 'a.jpg', contentType: 'image/jpeg', body: 'x' });
    await app.upload('/api/files', { filename: 'b.jpg', contentType: 'image/jpeg', body: 'y' });
    await app.upload('/api/files', { filename: 'c.txt', contentType: 'text/plain', body: 'z' });

    const res = await app.get('/api/facets?keys=ext,type');
    assert.equal(res.status, 200);
    const { facets } = res.json;
    assert.deepEqual(
      facets.ext.map((f) => [f.value, f.count]),
      [['jpg', 2], ['txt', 1]]
    );
    const byType = Object.fromEntries(facets.type.map((f) => [f.value, f.count]));
    assert.equal(byType.image, 2);
    assert.equal(byType.text, 1);

    // Then filtering by that facet narrows the search results.
    const filtered = await app.get('/api/search?q=' + encodeURIComponent('ext=jpg'));
    assert.equal(filtered.json.total, 2);
  } finally {
    await app.close();
  }
});
