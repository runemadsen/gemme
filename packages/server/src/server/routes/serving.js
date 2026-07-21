import { HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { getFile } from '../../lib/files.js';
import { servingFor, makeServingApi } from '../../lib/serving.js';
import { streamBytes, imageCacheControl } from '../render-response.js';
import { resolvePublic } from './public.js';

/**
 * Generic plugin serving — the one place derived renditions/streams are served,
 * by **extension dispatch**. The core knows no format: it takes the last path
 * segment's extension and hands the whole path to the first matching plugin that
 * registered that extension in its `serving.formats`. The plugin returns a
 * descriptor; the core streams it (Range, ETag/304, cache) uniformly.
 *
 *   GET /api/files/:id/*rest   (auth)   — e.g. /api/files/42/w=800.webp,
 *                                              /api/files/42/master.m3u8,
 *                                              /api/files/42/360p/seg_000.ts
 *   GET /i/:id/*rest           (public) — same, gated by collection visibility
 *
 * Registered LAST so specific routes (/download, /thumbnail, /collections) win
 * over this catch-all.
 */
export function registerServingRoutes(router) {
  router.get(
    '/api/files/:id/*rest',
    requireAuth(async (req, res, ctx) => {
      const id = Number(ctx.params.id);
      const file = Number.isInteger(id) && id > 0 ? getFile(ctx.db, id) : null;
      if (!file) throw new HttpError(404, 'Not found');
      await dispatchServe(req, res, ctx, file, ctx.params.rest);
    })
  );

  router.get('/i/:id/*rest', async (req, res, ctx) => {
    const file = resolvePublic(ctx); // 404s for non-public/missing
    await dispatchServe(req, res, ctx, file, ctx.params.rest);
  });
}

/**
 * Resolve `<rest>` (the path after the file id) to a plugin `serve` call and
 * stream the descriptor it returns. The final segment's extension selects the
 * plugin (among those that also `matches` the file); the plugin sees every
 * segment, so one callback can serve a manifest and its segments.
 */
async function dispatchServe(req, res, ctx, file, rest) {
  const segments = String(rest).split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  const dot = last.lastIndexOf('.');
  if (dot === -1) throw new HttpError(404, 'Not found');
  const ext = last.slice(dot + 1).toLowerCase();

  const plugin = servingFor(ctx.registry, file.mime_type, file.original_filename, ext);
  if (!plugin) throw new HttpError(404, 'Not found');

  const api = makeServingApi(
    ctx,
    { contentHash: file.content_hash, mimeType: file.mime_type, filename: file.original_filename },
    plugin
  );

  let descriptor;
  try {
    descriptor = await plugin.serving.serve({ source: api.source, segments, ext }, api);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err.message); // bad params (e.g. invalid transform)
  }
  if (!descriptor) throw new HttpError(404, 'Not found');

  streamBytes(req, res, { ...descriptor, cacheControl: imageCacheControl(ctx) });
}
