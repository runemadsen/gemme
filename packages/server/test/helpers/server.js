import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/lib/db/index.js';
import { createApp } from '../../src/server/index.js';
import { createEventBus } from '../../src/lib/bus.js';

/**
 * Boot an ephemeral app on a random port backed by a temp data directory.
 * Returns a client bound to that server plus a teardown function.
 */
export async function startTestApp({ onVersionCreated, events = createEventBus(), dev = false } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gemme-test-'));
  const db = openDatabase({ dataDir });
  const server = createApp({ db, dataDir, onVersionCreated, events, dev });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Minimal cookie jar so login state carries across requests.
  let cookie = '';

  async function req(method, pathname, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + pathname, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) cookie = c.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, res };
  }

  // Raw-body file upload (matches src/server/upload.js wire format).
  async function upload(pathname, { filename, contentType = 'application/octet-stream', body }) {
    const h = { 'x-filename': encodeURIComponent(filename), 'content-type': contentType };
    if (cookie) h.cookie = cookie;
    const res = await fetch(base + pathname, { method: 'POST', headers: h, body });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) cookie = c.split(';')[0];
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, res };
  }

  return {
    base,
    db,
    dataDir,
    events,
    req,
    upload,
    get: (p, o) => req('GET', p, o),
    post: (p, body, o) => req('POST', p, { ...o, body }),
    del: (p, o) => req('DELETE', p, o),
    cookieHeader: () => cookie,
    clearCookie: () => {
      cookie = '';
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      await fsp.rm(dataDir, { recursive: true, force: true });
    },
  };
}
