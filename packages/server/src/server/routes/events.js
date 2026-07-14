import { requireAuth } from '../middleware.js';

const HEARTBEAT_MS = 25000;

/**
 * Server-Sent Events stream. The browser opens one EventSource here and gets a
 * `change` event whenever the file list may have changed (upload, extraction
 * finished, delete). Plain text/event-stream over node:http — no dependencies.
 */
export function registerEventRoutes(router) {
  router.get(
    '/api/events',
    requireAuth((req, res, ctx) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // disable proxy buffering (e.g. nginx)
      });
      res.write(': connected\n\n');

      const onChange = (detail) => {
        res.write(`event: change\ndata: ${JSON.stringify(detail ?? {})}\n\n`);
      };
      ctx.events.on('change', onChange);

      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      heartbeat.unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        ctx.events.off('change', onChange);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      // Intentionally never end the response — the stream stays open.
    })
  );
}
