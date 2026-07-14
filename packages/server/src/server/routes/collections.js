import { sendJson, readJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  addFilesToCollection,
  removeFilesFromCollection,
  getFileCollectionIds,
} from '../../lib/collections.js';

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

export function registerCollectionRoutes(router) {
  // --- CRUD ---
  router.get(
    '/api/collections',
    requireAuth((req, res, ctx) => sendJson(res, 200, { collections: listCollections(ctx.db) }))
  );

  router.post(
    '/api/collections',
    requireAuth(async (req, res, ctx) => {
      const { name, parentId = null } = await readJson(req);
      const collection = createCollection(ctx.db, { name, parentId, userId: ctx.user.id });
      ctx.events?.emit('change', { type: 'collections' });
      sendJson(res, 201, { collection });
    })
  );

  router.patch(
    '/api/collections/:id',
    requireAuth(async (req, res, ctx) => {
      const id = intParam(ctx.params.id, 'collection id');
      const body = await readJson(req);
      const patch = {};
      if ('name' in body) patch.name = body.name;
      if ('parentId' in body) patch.parentId = body.parentId; // null = move to root
      if ('visibility' in body) patch.visibility = body.visibility; // 'private' | 'public'
      const collection = updateCollection(ctx.db, id, patch);
      ctx.events?.emit('change', { type: 'collections' });
      sendJson(res, 200, { collection });
    })
  );

  router.delete(
    '/api/collections/:id',
    requireAuth((req, res, ctx) => {
      deleteCollection(ctx.db, intParam(ctx.params.id, 'collection id'));
      ctx.events?.emit('change', { type: 'collections' });
      sendJson(res, 200, { ok: true });
    })
  );

  // --- membership ---
  // Read a single file's memberships (drives the detail-page checkboxes).
  router.get(
    '/api/files/:id/collections',
    requireAuth((req, res, ctx) => {
      const fileId = intParam(ctx.params.id, 'file id');
      sendJson(res, 200, { collectionIds: getFileCollectionIds(ctx.db, fileId) });
    })
  );

  // Bulk add/remove: one collection (path) × many files (body). Works with a
  // single id via a one-element array.
  router.post(
    '/api/collections/:id/files',
    requireAuth(async (req, res, ctx) => {
      const collectionId = intParam(ctx.params.id, 'collection id');
      const fileIds = fileIdList(await readJson(req));
      addFilesToCollection(ctx.db, collectionId, fileIds);
      ctx.events?.emit('change', { type: 'membership' });
      sendJson(res, 200, { ok: true, count: fileIds.length });
    })
  );

  router.delete(
    '/api/collections/:id/files',
    requireAuth(async (req, res, ctx) => {
      const collectionId = intParam(ctx.params.id, 'collection id');
      const fileIds = fileIdList(await readJson(req));
      removeFilesFromCollection(ctx.db, collectionId, fileIds);
      ctx.events?.emit('change', { type: 'membership' });
      sendJson(res, 200, { ok: true, count: fileIds.length });
    })
  );
}
