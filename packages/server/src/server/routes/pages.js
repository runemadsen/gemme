import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHtml, redirect, HttpError } from '../respond.js';
import { paginatedSearch } from '../../lib/search/search.js';
import { resolveState, composeQuery } from '../../lib/search/compose.js';
import { QueryError } from '../../lib/search/dsl.js';
import { getFile } from '../../lib/files.js';
import { getVersionMetadata } from '../../lib/metadata/store.js';
import {
  renderHome,
  renderLogin,
  renderDetail,
  renderNotFound,
  renderCollectionsPage,
  renderUploadPage,
} from '../../web/render.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../web/public/', import.meta.url));
const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function registerPageRoutes(router) {
  router.get('/login', (req, res, ctx) => {
    if (ctx.user) return redirect(res, '/');
    sendHtml(res, 200, renderLogin());
  });

  router.get('/', (req, res, ctx) => {
    if (!ctx.user) return redirect(res, '/login');
    // Render the grid filtered to the URL state so a shared link is correct on
    // first paint (and works before JS). Falls back to all on a malformed query.
    const state = resolveState(ctx.url.searchParams);
    let result;
    try {
      result = paginatedSearch(ctx.db, { ...state, query: composeQuery(state.text, state.filters) });
    } catch (err) {
      if (!(err instanceof QueryError)) throw err;
      result = paginatedSearch(ctx.db, { query: '' });
    }
    sendHtml(res, 200, renderHome({ user: ctx.user, result, state }));
  });

  router.get('/upload', (req, res, ctx) => {
    if (!ctx.user) return redirect(res, '/login');
    sendHtml(res, 200, renderUploadPage({ user: ctx.user }));
  });

  router.get('/collections', (req, res, ctx) => {
    if (!ctx.user) return redirect(res, '/login');
    sendHtml(res, 200, renderCollectionsPage({ user: ctx.user }));
  });

  router.get('/files/:id', (req, res, ctx) => {
    if (!ctx.user) return redirect(res, '/login');
    const id = Number(ctx.params.id);
    const file = Number.isInteger(id) ? getFile(ctx.db, id) : null;
    if (!file) return sendHtml(res, 404, renderNotFound({ user: ctx.user }));
    const metadata = file.current_version_id
      ? getVersionMetadata(ctx.db, file.current_version_id)
      : [];
    sendHtml(res, 200, renderDetail({ user: ctx.user, file, metadata }));
  });

  // Static files (flat directory, basename only — no traversal).
  router.get('/static/:file', (req, res, ctx) => {
    const name = path.basename(ctx.params.file);
    const file = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
    const type = CONTENT_TYPES[path.extname(name)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
