import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/lib/auth/users.js';

test('unauthenticated pages redirect to /login', async () => {
  const app = await startTestApp();
  try {
    const res = await fetch(`${app.base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  } finally {
    await app.close();
  }
});

test('login page renders and mounts the app script', async () => {
  const app = await startTestApp();
  try {
    const res = await app.get('/login');
    assert.equal(res.status, 200);
    assert.match(res.res.headers.get('content-type'), /text\/html/);
    assert.match(res.text, /login-form/);
    assert.match(res.text, /\/static\/app\.js/);
  } finally {
    await app.close();
  }
});

test('home page renders islands and uploaded files once logged in', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    await app.upload('/api/files', { filename: 'hello.txt', contentType: 'text/plain', body: 'hi' });

    const res = await app.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<gemme-search/);
    assert.match(res.text, /hello\.txt/);
    assert.doesNotMatch(res.text, /<gemme-uploader>/, 'uploader moved off the home page');
  } finally {
    await app.close();
  }
});

test('the uploader lives on its own /upload page (linked in the nav)', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });

    assert.match((await app.get('/')).text, /href="\/upload"/); // nav link
    const up = await app.get('/upload');
    assert.equal(up.status, 200);
    assert.match(up.text, /<gemme-uploader>/);
    assert.match(up.text, /<a href="\/upload" class="active">Upload<\/a>/);
  } finally {
    await app.close();
  }
});

test('home page renders the grid filtered to the URL (shareable filter links)', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    await app.upload('/api/files', { filename: 'a.jpg', contentType: 'image/jpeg', body: 'a' });
    await app.upload('/api/files', { filename: 'b.png', contentType: 'image/png', body: 'b' });
    await app.upload('/api/files', { filename: 'c.txt', contentType: 'text/plain', body: 'c' });

    // Unfiltered: all three present.
    const all = await app.get('/');
    assert.match(all.text, /a\.jpg/);
    assert.match(all.text, /b\.png/);
    assert.match(all.text, /c\.txt/);

    // Filtered by extension via the URL: only a.jpg on first paint.
    const jpg = await app.get('/?ext=jpg');
    assert.match(jpg.text, /a\.jpg/);
    assert.doesNotMatch(jpg.text, /b\.png/);
    assert.doesNotMatch(jpg.text, /c\.txt/);

    // Multi-value (OR) + another facet.
    const imgs = await app.get('/?ext=jpg&ext=png');
    assert.match(imgs.text, /a\.jpg/);
    assert.match(imgs.text, /b\.png/);
    assert.doesNotMatch(imgs.text, /c\.txt/);
  } finally {
    await app.close();
  }
});

test('typed ?q=ext:jpg renders identically to clicked ?ext=jpg', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    await app.upload('/api/files', { filename: 'a.jpg', contentType: 'image/jpeg', body: 'a' });
    await app.upload('/api/files', { filename: 'b.png', contentType: 'image/png', body: 'b' });

    const typed = await app.get('/?q=' + encodeURIComponent('ext:jpg'));
    const clicked = await app.get('/?ext=jpg');
    for (const r of [typed, clicked]) {
      assert.match(r.text, /a\.jpg/);
      assert.doesNotMatch(r.text, /b\.png/);
    }
  } finally {
    await app.close();
  }
});

test('home page renders sorted per the URL, with controls + pager', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    for (const n of ['banana.txt', 'apple.txt', 'cherry.txt'])
      await app.upload('/api/files', { filename: n, contentType: 'text/plain', body: n });

    const res = await app.get('/?sort=name&direction=asc');
    // names appear in ascending order in the HTML
    const order = [...res.text.matchAll(/class="name"[^>]*>([^<]+)/g)].map((m) => m[1]);
    assert.deepEqual(order, ['apple.txt', 'banana.txt', 'cherry.txt']);
    // controls reflect the selection
    assert.match(res.text, /<option value="name" selected>/);
    assert.match(res.text, /<option value="asc" selected>/);

    // perPage=2 produces a 2-page pager
    const paged = await app.get('/?perPage=2');
    assert.match(paged.text, /class="pager"/);
    assert.match(paged.text, /data-pages="2"/);
  } finally {
    await app.close();
  }
});

test('file detail page shows versions and metadata table', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    const up = await app.upload('/api/files', { filename: 'doc.md', contentType: 'text/markdown', body: 'x' });
    const res = await app.get(`/files/${up.json.file.id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /doc\.md/);
    assert.match(res.text, /Versions/);
    assert.match(res.text, /Metadata/);
  } finally {
    await app.close();
  }
});

test('detail page shows a public URL + srcset snippet only when the file is public', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    const up = await app.upload('/api/files', { filename: 'p.png', contentType: 'image/png', body: 'imgbytes' });
    const id = up.json.file.id;

    // Private: no public URL section.
    assert.doesNotMatch((await app.get(`/files/${id}`)).text, /Public URL/);

    // Put it in a public collection.
    const c = (await app.post('/api/collections', { name: 'Pub' })).json.collection;
    await app.post(`/api/collections/${c.id}/files`, { fileIds: [id] });
    await app.req('PATCH', `/api/collections/${c.id}`, { body: { visibility: 'public' } });

    const html = (await app.get(`/files/${id}`)).text;
    assert.match(html, /Public URL/);
    assert.match(html, new RegExp(`/i/${id}`));
    assert.match(html, /srcset=/); // image → variant snippet
  } finally {
    await app.close();
  }
});

test('home has the collections tree; /collections renders the manager; detail has membership', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    const up = await app.upload('/api/files', { filename: 'x.txt', contentType: 'text/plain', body: 'x' });

    assert.match((await app.get('/')).text, /<gemme-collections>/);
    assert.match((await app.get('/')).text, /href="\/collections"/); // nav link

    const mgr = await app.get('/collections');
    assert.equal(mgr.status, 200);
    assert.match(mgr.text, /<gemme-collection-manager>/);

    const detail = await app.get(`/files/${up.json.file.id}`);
    assert.match(detail.text, /<gemme-file-collections data-file="/);
  } finally {
    await app.close();
  }
});

test('static app.js and styles.css are served with correct content types', async () => {
  const app = await startTestApp();
  try {
    const js = await app.get('/static/app.js');
    assert.equal(js.status, 200);
    assert.match(js.res.headers.get('content-type'), /javascript/);
    assert.match(js.text, /customElements\.define/);

    const css = await app.get('/static/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.res.headers.get('content-type'), /text\/css/);

    // no path traversal
    assert.equal((await app.get('/static/..%2F..%2Fpackage.json')).status, 404);
  } finally {
    await app.close();
  }
});
