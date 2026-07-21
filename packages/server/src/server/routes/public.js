import { HttpError } from '../respond.js';
import { getFile } from '../../lib/files.js';
import { isFilePublic } from '../../lib/collections.js';
import { streamBytes, imageCacheControl } from '../render-response.js';

/**
 * Unauthenticated public serving for files in a public collection (or a
 * descendant of one). Non-public/missing files answer 404 — never 403 — so we
 * don't leak which ids exist.
 *
 * This module serves only the **original bytes** at `GET /i/:id` (Range-enabled).
 * Plugin renditions/streams are served (publicly) by `routes/serving.js` at
 * `GET /i/:id/*rest` via extension dispatch — the core hardcodes no format.
 *
 * Long-lived immutable cache (dev: `no-cache`): a file's bytes never change, so
 * the by-id URL fully identifies them. See `imageCacheControl` for the
 * visibility-revocation tradeoff.
 */
export function registerPublicRoutes(router) {
  router.get('/i/:id', (req, res, ctx) => {
    const file = resolvePublic(ctx);
    if (!ctx.blobStore.has(file.content_hash)) throw new HttpError(404, 'Not found');
    streamBytes(req, res, {
      size: file.byte_size,
      contentType: file.mime_type || 'application/octet-stream',
      etag: `"${file.content_hash}"`,
      cacheControl: imageCacheControl(ctx),
      open: (range) => ctx.blobStore.createReadStream(file.content_hash, range),
    });
  });
}

/**
 * Resolve id → file, enforcing public visibility (404 otherwise). Exported so
 * the shared serving route can gate public plugin renditions the same way.
 */
export function resolvePublic(ctx) {
  const id = Number(ctx.params.id);
  const file = Number.isInteger(id) && id > 0 ? getFile(ctx.db, id) : null;
  if (!file || !isFilePublic(ctx.db, id)) throw new HttpError(404, 'Not found');
  return file;
}
