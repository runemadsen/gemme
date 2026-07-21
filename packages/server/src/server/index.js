import http from 'node:http';
import { Router } from './router.js';
import { sendJson, sendText, HttpError } from './respond.js';
import { parseCookies, getSessionUser, SESSION_COOKIE } from '../lib/auth/sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFileRoutes } from './routes/files.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerEventRoutes } from './routes/events.js';
import { registerFacetRoutes } from './routes/facets.js';
import { registerCollectionRoutes } from './routes/collections.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerServingRoutes } from './routes/serving.js';
import { BlobStore } from '../lib/storage/blobs.js';
import { DerivedStore } from '../lib/storage/derived.js';
import { createEventBus } from '../lib/bus.js';

/**
 * Build the router with all API routes registered. Exposed separately so tests
 * can exercise routing without binding a port.
 */
export function buildRouter() {
  const router = new Router();
  router.get('/health', (req, res) => sendJson(res, 200, { status: 'ok' }));
  registerAuthRoutes(router);
  registerFileRoutes(router);
  registerSearchRoutes(router);
  registerPageRoutes(router);
  registerEventRoutes(router);
  registerFacetRoutes(router);
  registerCollectionRoutes(router);
  registerPublicRoutes(router);
  // Registered LAST: the generic `*rest` serving catch-alls must yield to the
  // specific routes above (/download, /thumbnail, /api/files/:id/collections, …).
  registerServingRoutes(router);
  return router;
}

/**
 * Create (but do not listen on) the HTTP server. Returns a plain node:http
 * server so callers/tests control the lifecycle.
 *
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.dataDir
 * @param {boolean} [opts.secure] - set Secure on cookies (behind HTTPS)
 */
export function createApp({ db, dataDir, secure = false, dev = false, registry, onFileCreated, events = createEventBus() }) {
  const router = buildRouter();
  const blobStore = new BlobStore(dataDir);
  const derivedStore = new DerivedStore(dataDir);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = router.match(req.method, url.pathname);

      if (!match) return sendJson(res, 404, { error: 'Not found' });
      if (match.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed' });

      // Resolve the session user (if any) for this request.
      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies[SESSION_COOKIE] ?? null;
      const user = getSessionUser(db, sessionToken);

      const ctx = {
        db,
        dataDir,
        blobStore,
        derivedStore,
        registry,
        events,
        secure,
        dev,
        params: match.params,
        url,
        user,
        sessionToken,
        onFileCreated,
      };
      await match.handler(req, res, ctx);
    } catch (err) {
      handleError(res, err);
    }
  });
}

/** Create the server and start listening. */
export function startServer({ db, port, dataDir, secure = false, dev = false, registry, onFileCreated, events }) {
  const server = createApp({ db, dataDir, secure, dev, registry, onFileCreated, events });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      console.log(`Gemme listening on http://localhost:${addr.port}`);
      console.log(`Data directory: ${dataDir}`);
      resolve(server);
    });
  });
}

function handleError(res, err) {
  if (res.headersSent) return res.end();
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.message });
  }
  console.error(err);
  return sendText(res, 500, 'Internal Server Error');
}
