import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers/server.js';
import { createUser } from '../src/auth/users.js';

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

test('home page renders islands and uploaded assets once logged in', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    await app.upload('/api/assets', { filename: 'hello.txt', contentType: 'text/plain', body: 'hi' });

    const res = await app.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<archive-uploader>/);
    assert.match(res.text, /<archive-search/);
    assert.match(res.text, /hello\.txt/);
  } finally {
    await app.close();
  }
});

test('asset detail page shows versions and metadata table', async () => {
  const app = await startTestApp();
  try {
    await createUser(app.db, { email: 'r@example.com', password: 'supersecret' });
    await app.post('/api/login', { email: 'r@example.com', password: 'supersecret' });
    const up = await app.upload('/api/assets', { filename: 'doc.md', contentType: 'text/markdown', body: 'x' });
    const res = await app.get(`/assets/${up.json.asset.id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /doc\.md/);
    assert.match(res.text, /Versions/);
    assert.match(res.text, /Metadata/);
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
