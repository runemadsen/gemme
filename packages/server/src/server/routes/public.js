import { HttpError } from '../respond.js';
import { getFile } from '../../lib/files.js';
import { isFilePublic } from '../../lib/collections.js';
import { rendererFor, parseSpecSegment } from '../../lib/renditions.js';
import { streamRendition, notModified } from '../render-response.js';

/**
 * Unauthenticated public serving for files in a public collection (or a
 * descendant of one). Serves the **current version only**. Non-public/missing
 * files answer 404 — never 403 — so we don't leak which ids exist.
 *
 * URLs:
 *   GET /i/:id             → original current-version bytes (any type)
 *   GET /i/:id/:spec       → image rendition, e.g. /i/42/w=800,fit=cover.webp
 *                            (output format is the extension; params are clamped)
 */
export function registerPublicRoutes(router) {
  router.get('/i/:id', (req, res, ctx) => {
    const { file, version } = resolvePublic(ctx);
    if (!ctx.blobStore.has(version.content_hash)) throw new HttpError(404, 'Not found');
    const etag = `"${version.content_hash}"`;
    const cacheControl = publicCacheControl(ctx);
    if (notModified(req, etag)) {
      res.writeHead(304, { etag, 'cache-control': cacheControl });
      res.end();
      return;
    }
    res.writeHead(200, {
      etag,
      'cache-control': cacheControl,
      'content-type': version.mime_type || 'application/octet-stream',
      'content-length': version.byte_size,
    });
    ctx.blobStore.createReadStream(version.content_hash).pipe(res);
  });

  router.get('/i/:id/:spec', async (req, res, ctx) => {
    const { file, version } = resolvePublic(ctx);
    const renderer = rendererFor(ctx.registry, version.mime_type, file.original_filename);
    if (!renderer) throw new HttpError(415, 'Not renderable');

    const parsed = parseSpecSegment(ctx.params.spec);
    if (!parsed || !renderer.formats.includes(parsed.ext)) throw new HttpError(404, 'Not found');
    let spec;
    try {
      spec = renderer.normalize(parsed.params);
    } catch (err) {
      throw new HttpError(400, err.message);
    }

    const source = {
      contentHash: version.content_hash,
      mimeType: version.mime_type,
      filename: file.original_filename,
    };
    await streamRendition(req, res, ctx, source, renderer, spec, parsed.ext, publicCacheControl(ctx));
  });
}

/** Resolve id → { file, current version }, enforcing public visibility (404 otherwise). */
function resolvePublic(ctx) {
  const id = Number(ctx.params.id);
  const file = Number.isInteger(id) && id > 0 ? getFile(ctx.db, id) : null;
  const version = file?.versions.find((v) => v.id === file.current_version_id);
  if (!version || !isFilePublic(ctx.db, id)) throw new HttpError(404, 'Not found');
  return { file, version };
}

// Stable by-id URLs (no content hash), so they can't be immutable: revalidate
// against the ETag. On a new current version the source hash — hence the ETag —
// changes, so CDNs/browsers pick it up. Dev never caches (mirrors files.js).
function publicCacheControl(ctx) {
  return ctx.dev ? 'no-cache' : 'public, max-age=300, stale-while-revalidate=604800';
}
