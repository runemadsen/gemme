import { sendJson, readJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  addFileToCollection,
  removeFileFromCollection,
  getFileCollectionIds,
} from '../../lib/collections.js';

function intParam(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what}`);
  return n;
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
  router.get(
    '/api/files/:id/collections',
    requireAuth((req, res, ctx) => {
      const fileId = intParam(ctx.params.id, 'file id');
      sendJson(res, 200, { collectionIds: getFileCollectionIds(ctx.db, fileId) });
    })
  );

  router.post(
    '/api/files/:id/collections',
    requireAuth(async (req, res, ctx) => {
      const fileId = intParam(ctx.params.id, 'file id');
      const { collectionId } = await readJson(req);
      addFileToCollection(ctx.db, fileId, intParam(collectionId, 'collection id'));
      ctx.events?.emit('change', { type: 'membership' });
      sendJson(res, 200, { ok: true });
    })
  );

  router.delete(
    '/api/files/:id/collections/:cid',
    requireAuth((req, res, ctx) => {
      const fileId = intParam(ctx.params.id, 'file id');
      const cid = intParam(ctx.params.cid, 'collection id');
      removeFileFromCollection(ctx.db, fileId, cid);
      ctx.events?.emit('change', { type: 'membership' });
      sendJson(res, 200, { ok: true });
    })
  );
}
