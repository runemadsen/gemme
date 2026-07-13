import { sendJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { searchAssets } from '../../search/search.js';
import { QueryError } from '../../search/dsl.js';

export function registerSearchRoutes(router) {
  router.get(
    '/api/search',
    requireAuth((req, res, ctx) => {
      const q = ctx.url.searchParams.get('q') || '';
      const limit = clamp(Number(ctx.url.searchParams.get('limit')) || 50, 1, 200);
      const offset = Math.max(0, Number(ctx.url.searchParams.get('offset')) || 0);
      try {
        sendJson(res, 200, searchAssets(ctx.db, q, { limit, offset }));
      } catch (err) {
        if (err instanceof QueryError) throw new HttpError(400, err.message);
        throw err;
      }
    })
  );
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
