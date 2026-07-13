import { sendJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { receiveUpload } from '../upload.js';
import {
  createAssetWithVersion,
  addVersion,
  getAsset,
  listAssets,
  softDeleteAsset,
  deleteVersion,
} from '../../lib/assets.js';

function intParam(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what}`);
  return n;
}

export function registerAssetRoutes(router) {
  // Upload a new asset (one file per request, raw body).
  router.post(
    '/api/assets',
    requireAuth(async (req, res, ctx) => {
      const up = await receiveUpload(req, ctx.blobStore);
      const asset = createAssetWithVersion(ctx.db, {
        filename: up.filename,
        mimeType: up.mimeType,
        hash: up.hash,
        size: up.size,
        userId: ctx.user.id,
      });
      ctx.onVersionCreated?.(asset.current_version_id);
      ctx.events?.emit('change', { type: 'created', assetId: asset.id });
      sendJson(res, 201, { asset });
    })
  );

  // Add a new version to an existing asset.
  router.post(
    '/api/assets/:id/versions',
    requireAuth(async (req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const up = await receiveUpload(req, ctx.blobStore);
      const asset = addVersion(ctx.db, id, {
        mimeType: up.mimeType,
        hash: up.hash,
        size: up.size,
        userId: ctx.user.id,
      });
      ctx.onVersionCreated?.(asset.current_version_id);
      ctx.events?.emit('change', { type: 'version', assetId: asset.id });
      sendJson(res, 201, { asset });
    })
  );

  router.get(
    '/api/assets',
    requireAuth((req, res, ctx) => {
      const limit = clamp(Number(ctx.url.searchParams.get('limit')) || 50, 1, 200);
      const offset = Math.max(0, Number(ctx.url.searchParams.get('offset')) || 0);
      sendJson(res, 200, listAssets(ctx.db, { limit, offset }));
    })
  );

  router.get(
    '/api/assets/:id',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const asset = getAsset(ctx.db, id);
      if (!asset) throw new HttpError(404, 'Asset not found');
      sendJson(res, 200, { asset });
    })
  );

  router.delete(
    '/api/assets/:id',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      softDeleteAsset(ctx.db, id);
      ctx.events?.emit('change', { type: 'deleted', assetId: id });
      sendJson(res, 200, { ok: true });
    })
  );

  router.delete(
    '/api/assets/:id/versions/:vid',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const vid = intParam(ctx.params.vid, 'version id');
      const result = deleteVersion(ctx.db, id, vid);
      sendJson(res, 200, result);
    })
  );

  // Download the current version's bytes.
  router.get(
    '/api/assets/:id/download',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const asset = getAsset(ctx.db, id);
      if (!asset || !asset.current_version_id) throw new HttpError(404, 'Asset not found');
      const version = asset.versions.find((v) => v.id === asset.current_version_id);
      streamVersion(res, ctx, asset, version);
    })
  );

  // Download a specific version's bytes.
  router.get(
    '/api/assets/:id/versions/:vid/download',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const vid = intParam(ctx.params.vid, 'version id');
      const asset = getAsset(ctx.db, id);
      const version = asset?.versions.find((v) => v.id === vid);
      if (!version) throw new HttpError(404, 'Version not found');
      streamVersion(res, ctx, asset, version);
    })
  );

  // Thumbnail for the current version (404 when none — the UI shows a placeholder).
  router.get(
    '/api/assets/:id/thumbnail',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const asset = getAsset(ctx.db, id);
      const version = asset?.versions.find((v) => v.id === asset.current_version_id);
      streamThumbnail(res, ctx, version);
    })
  );

  // Thumbnail for a specific version.
  router.get(
    '/api/assets/:id/versions/:vid/thumbnail',
    requireAuth((req, res, ctx) => {
      const id = intParam(ctx.params.id, 'asset id');
      const vid = intParam(ctx.params.vid, 'version id');
      const asset = getAsset(ctx.db, id);
      const version = asset?.versions.find((v) => v.id === vid);
      streamThumbnail(res, ctx, version);
    })
  );
}

function streamThumbnail(res, ctx, version) {
  if (!version || !version.thumbnail_type) throw new HttpError(404, 'No thumbnail');
  if (!ctx.derivedStore.hasThumb(version.content_hash, version.thumbnail_type)) {
    throw new HttpError(404, 'No thumbnail');
  }
  res.writeHead(200, {
    'content-type': version.thumbnail_type,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  ctx.derivedStore.createThumbReadStream(version.content_hash, version.thumbnail_type).pipe(res);
}

function streamVersion(res, ctx, asset, version) {
  if (!ctx.blobStore.has(version.content_hash)) {
    throw new HttpError(410, 'Blob no longer available');
  }
  res.writeHead(200, {
    'content-type': version.mime_type || 'application/octet-stream',
    'content-length': version.byte_size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.original_filename)}`,
  });
  ctx.blobStore.createReadStream(version.content_hash).pipe(res);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
