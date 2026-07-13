import { sendJson, HttpError } from '../respond.js';
import { requireAuth } from '../middleware.js';
import { paginatedSearch } from '../../lib/search/search.js';
import { QueryError } from '../../lib/search/dsl.js';

export function registerSearchRoutes(router) {
  router.get(
    '/api/search',
    requireAuth((req, res, ctx) => {
      const sp = ctx.url.searchParams;
      try {
        sendJson(
          res,
          200,
          paginatedSearch(ctx.db, {
            query: sp.get('q') || '',
            sort: sp.get('sort'),
            direction: sp.get('direction'),
            page: sp.get('page'),
            perPage: sp.get('perPage'),
          })
        );
      } catch (err) {
        if (err instanceof QueryError) throw new HttpError(400, err.message);
        throw err;
      }
    })
  );
}
