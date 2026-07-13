import { sendJson } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { getFacets } from '../../lib/facets.js';

const MAX_KEYS = 20;

export function registerFacetRoutes(router) {
  // GET /api/facets?keys=ext,type  ->  { facets: { ext: [{value,count}], … } }
  router.get(
    '/api/facets',
    requireAuth((req, res, ctx) => {
      const keys = (ctx.url.searchParams.get('keys') || 'ext')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, MAX_KEYS);
      sendJson(res, 200, { facets: getFacets(ctx.db, keys) });
    })
  );
}
