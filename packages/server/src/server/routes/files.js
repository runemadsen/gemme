import { sendJson, readJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { receiveUpload } from '../upload.js';
import { rendererFor, thumbnailSpec } from '../../lib/renditions.js';
import { streamRendition } from '../render-response.js';
import {
  createFileWithVersion,
  addVersion,
  getFile,
  listFiles,
  softDeleteFiles,
  deleteVersion,
  findDuplicateFile,
} from '../../lib/files.js';

function intParam(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what}`);
  return n;
}

/** Validate a `{ fileIds }` body → array of positive ints (at least one). */
function fileIdList(body) {
  const ids = body?.fileIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, 'fileIds must be a non-empty array');
  return ids.map((id) => intParam(id, 'file id'));
}

export function registerFileRoutes(router) {
  // Upload a new file (one file per request, raw body).
  router.post(
    '/api/files',
    requireAuth(async (req, res, ctx) => {
      const up = await receiveUpload(req, ctx.blobStore);

      // Skip re-importing the exact same file (same name + content hash).
      const duplicate = findDuplicateFile(ctx.db, { filename: up.filename, hash: up.hash });
      if (duplicate) {
        sendJson(res, 200, { file: duplicate, skipped: true });
        return;
      }

      const file = createFileWithVersion(ctx.db, {
        filename: up.filename,
        mimeType: up.mimeType,
        hash: up.hash,
        size: up.size,
        userId: ctx.user.id,
      });
      ctx.onVersionCreated?.(file.current_version_id);
      ctx.events?.emit('change', { type: 'created', fileId: file.id });
      sendJson(res, 201, { file, skipped: false });
    })
  );

  // Add a new version to an existing file.
  router.post(
    '/api/files/:id/versions',
    requireAuth(async (req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const up = await receiveUpload(req, ctx.blobStore);

      const existing = getFile(ctx.db, id);
      if (!existing) throw new HttpError(404, 'File not found');

      // Skip if the upload is byte-identical to the current version.
      const current = existing.versions.find((v) => v.id === existing.current_version_id);
      if (current && current.content_hash === up.hash) {
        sendJson(res, 200, { file: existing, skipped: true });
        return;
      }

      const file = addVersion(ctx.db, id, {
        mimeType: up.mimeType,
        hash: up.hash,
        size: up.size,
        userId: ctx.user.id,
      });
      ctx.onVersionCreated?.(file.current_version_id);
      ctx.events?.emit('change', { type: 'version', fileId: file.id });
      sendJson(res, 201, { file, skipped: false });
    })
  );

  router.get(
    '/api/files',
    requireAuth((req, res, ctx) => {
      const limit = clamp(Number(ctx.url.searchParams.get('limit')) || 50, 1, 200);
      const offset = Math.max(0, Number(ctx.url.searchParams.get('offset')) || 0);
      sendJson(res, 200, listFiles(ctx.db, { limit, offset }));
    })
  );

  router.get(
    '/api/files/:id',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const file = getFile(ctx.db, id);
      if (!file) throw new HttpError(404, 'File not found');
      sendJson(res, 200, { file });
    })
  );

  // Bulk soft-delete. Works with a single id via a one-element array.
  router.delete(
    '/api/files',
    requireAuth(async (req, res, ctx) => {
      const fileIds = fileIdList(await readJson(req));
      softDeleteFiles(ctx.db, fileIds);
      ctx.events?.emit('change', { type: 'deleted' });
      sendJson(res, 200, { ok: true, count: fileIds.length });
    })
  );

  router.delete(
    '/api/files/:id/versions/:vid',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const vid = intParam(ctx.params.vid, 'version id');
      const result = deleteVersion(ctx.db, id, vid);
      sendJson(res, 200, result);
    })
  );

  // Download the current version's bytes — a "latest" pointer, so never immutable.
  router.get(
    '/api/files/:id/download',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const file = getFile(ctx.db, id);
      if (!file || !file.current_version_id) throw new HttpError(404, 'File not found');
      const version = file.versions.find((v) => v.id === file.current_version_id);
      streamVersion(req, res, ctx, file, version, { pinned: false });
    })
  );

  // Download a specific version's bytes — version-pinned, so safely immutable.
  router.get(
    '/api/files/:id/versions/:vid/download',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const vid = intParam(ctx.params.vid, 'version id');
      const file = getFile(ctx.db, id);
      const version = file?.versions.find((v) => v.id === vid);
      if (!version) throw new HttpError(404, 'Version not found');
      streamVersion(req, res, ctx, file, version, { pinned: true });
    })
  );

  // Thumbnail for the current version (404 when none — the UI shows a placeholder).
  // "Latest" pointer, so never immutable.
  router.get(
    '/api/files/:id/thumbnail',
    requireAuth(async (req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const file = getFile(ctx.db, id);
      const version = file?.versions.find((v) => v.id === file.current_version_id);
      await serveThumbnail(req, res, ctx, file, version, { pinned: false });
    })
  );

  // Thumbnail for a specific version — version-pinned, so safely immutable.
  router.get(
    '/api/files/:id/versions/:vid/thumbnail',
    requireAuth(async (req, res, ctx) => {
      const id = intParam(ctx.params.id, 'file id');
      const vid = intParam(ctx.params.vid, 'version id');
      const file = getFile(ctx.db, id);
      const version = file?.versions.find((v) => v.id === vid);
      await serveThumbnail(req, res, ctx, file, version, { pinned: true });
    })
  );
}

/** True if the client's If-None-Match matches, so we can 304. */
function notModified(req, etag) {
  const inm = req.headers['if-none-match'];
  return inm != null && inm === etag;
}

/**
 * Cache policy for images.
 *
 * A URL that names a specific version (`pinned`) serves bytes that can never
 * change — in production a version is written exactly once (created, extracted,
 * thumbnailed) and never regenerated — so it's safe to cache `immutable` (fast,
 * zero revalidation). The bare "current" routes (`pinned: false`) track a moving
 * pointer, so they always revalidate against an ETag.
 *
 * The one exception is dev mode (`ctx.dev`): re-running extraction locally
 * rewrites a thumbnail for the *same* version, which would break the immutable
 * promise, so dev never sends `immutable`. This is the only place the promise
 * can be broken, and it's confined to development.
 */
function cacheControl(ctx, pinned) {
  return pinned && !ctx.dev ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * Serve a version's thumbnail — the renderer's pre-generated `thumbnail` preset
 * rendition (generated on demand if not yet cached). 404 when the file has no
 * renderer (the UI falls back to a placeholder). Shares the rendition cache with
 * public transforms of the same size.
 */
async function serveThumbnail(req, res, ctx, file, version, { pinned } = {}) {
  if (!version) throw new HttpError(404, 'No thumbnail');
  const renderer = rendererFor(ctx.registry, version.mime_type, file.original_filename);
  if (!renderer) throw new HttpError(404, 'No thumbnail');
  const { spec, ext } = thumbnailSpec(renderer);
  const source = {
    contentHash: version.content_hash,
    mimeType: version.mime_type,
    filename: file.original_filename,
  };
  await streamRendition(req, res, ctx, source, renderer, spec, ext, cacheControl(ctx, pinned));
}

function streamVersion(req, res, ctx, file, version, { pinned } = {}) {
  if (!ctx.blobStore.has(version.content_hash)) {
    throw new HttpError(410, 'Blob no longer available');
  }
  // The bytes ARE the content hash, so it's a perfect strong validator.
  const etag = `"${version.content_hash}"`;
  if (notModified(req, etag)) {
    res.writeHead(304, { etag, 'cache-control': cacheControl(ctx, pinned) });
    res.end();
    return;
  }
  res.writeHead(200, {
    etag,
    'cache-control': cacheControl(ctx, pinned),
    'content-type': version.mime_type || 'application/octet-stream',
    'content-length': version.byte_size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.original_filename)}`,
  });
  ctx.blobStore.createReadStream(version.content_hash).pipe(res);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
