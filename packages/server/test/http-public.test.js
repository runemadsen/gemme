import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

// Unauthenticated GET (no cookie) — proves the /i routes need no login.
async function pub(app, pathname, headers = {}) {
  const res = await fetch(app.base + pathname, { headers });
  return {
    status: res.status,
    text: await res.text(),
    ct: res.headers.get('content-type'),
    etag: res.headers.get('etag'),
    cc: res.headers.get('cache-control'),
  };
}

async function setup(app) {
  await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
  await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
  const img = (await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' })).json.file;
  const txt = (await app.upload('/api/files', { filename: 'n.txt', contentType: 'text/plain', body: 'hello' })).json.file;
  const parent = (await app.post('/api/collections', { name: 'Pub' })).json.collection;
  const child = (await app.post('/api/collections', { name: 'Child', parentId: parent.id })).json.collection;
  return { img, txt, parent, child };
}

test('files in a public collection (or its subtree) are served; private are 404', async () => {
  const app = await startTestApp();
  try {
    const { img, parent, child } = await setup(app);
    // Put the image in the CHILD collection (public will come via the ancestor).
    await app.post(`/api/collections/${child.id}/files`, { fileIds: [img.id] });

    // Not public yet → 404 (and no existence leak vs 403).
    assert.equal((await pub(app, `/i/${img.id}`)).status, 404);

    // Make the ancestor public → the child's file is now public.
    await app.req('PATCH', `/api/collections/${parent.id}`, { body: { visibility: 'public' } });

    const orig = await pub(app, `/i/${img.id}`);
    assert.equal(orig.status, 200);
    assert.equal(orig.ct, 'image/png');
    assert.equal(orig.text, 'imgbytes');

    // A file in no public collection → 404.
    const { txt } = { txt: (await app.get('/api/files')).json.items.find((i) => i.original_filename === 'n.txt') };
    assert.equal((await pub(app, `/i/${txt.id}`)).status, 404);
  } finally {
    await app.close();
  }
});

test('transform: content-type from extension, revalidated cache, 304, clamp, bad ext', async () => {
  const app = await startTestApp();
  try {
    const { img, parent, child } = await setup(app);
    await app.post(`/api/collections/${child.id}/files`, { fileIds: [img.id] });
    await app.req('PATCH', `/api/collections/${parent.id}`, { body: { visibility: 'public' } });

    const t = await pub(app, `/i/${img.id}/w=400.webp`);
    assert.equal(t.status, 200);
    assert.equal(t.ct, 'image/webp');
    assert.match(t.text, /^RENDITION:webp:400x/); // fake renderer output
    assert.ok(t.etag);
    assert.match(t.cc, /max-age=\d+/);
    assert.match(t.cc, /stale-while-revalidate/);

    // Revalidation → 304.
    const nm = await pub(app, `/i/${img.id}/w=400.webp`, { 'if-none-match': t.etag });
    assert.equal(nm.status, 304);
    assert.equal(nm.text, '');

    // Out-of-range width is clamped (still 200, not 400).
    assert.equal((await pub(app, `/i/${img.id}/w=999999.webp`)).status, 200);

    // Unknown output extension → 404.
    assert.equal((await pub(app, `/i/${img.id}/w=100.tiff`)).status, 404);

    // A different format is a different cached variant.
    const jpg = await pub(app, `/i/${img.id}/w=400.jpg`);
    assert.equal(jpg.status, 200);
    assert.equal(jpg.ct, 'image/jpeg');
  } finally {
    await app.close();
  }
});

test('transform on a non-renderable public file → 415', async () => {
  const app = await startTestApp();
  try {
    const { txt, parent } = await setup(app);
    await app.post(`/api/collections/${parent.id}/files`, { fileIds: [txt.id] });
    await app.req('PATCH', `/api/collections/${parent.id}`, { body: { visibility: 'public' } });

    // Original bytes still serve (it's public)...
    assert.equal((await pub(app, `/i/${txt.id}`)).status, 200);
    // ...but there's no renderer for text → transform is 415.
    assert.equal((await pub(app, `/i/${txt.id}/w=100.webp`)).status, 415);
  } finally {
    await app.close();
  }
});
