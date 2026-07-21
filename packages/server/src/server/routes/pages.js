import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHtml, redirect, HttpError } from '../respond.js';
import { paginatedSearch } from '../../lib/search/search.js';
import { resolveState, composeQuery } from '../../lib/search/compose.js';
import { QueryError } from '../../lib/search/dsl.js';
import { getFile } from '../../lib/files.js';
import { isFilePublic } from '../../lib/collections.js';
import { getFileMetadata } from '../../lib/metadata/store.js';
import { safeMember } from '../../lib/storage/derived.js';
import {
  renderHome,
  renderLogin,
  renderDetail,
  renderNotFound,
  renderCollectionsPage,
  renderUploadPage,
  previewHelpers,
} from '../../web/render.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../web/public/', import.meta.url));
const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
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
    const metadata = getFileMetadata(ctx.db, file.id);
    const isPublic = isFilePublic(ctx.db, id);
    // The detail preview is owned by the plugin (core stays format-agnostic):
    // ask the first matching plugin with a `preview` capability for its HTML.
    const plugin = ctx.registry?.matching?.(file.mime_type, file.original_filename).find((p) => p.preview);
    const preview = plugin ? plugin.preview(file, previewHelpers(plugin, file, { isPublic })) || '' : '';
    sendHtml(res, 200, renderDetail({ user: ctx.user, file, metadata, isPublic, preview }));
  });

  // Serve a plugin's own static `assets/` (player JS, hls.js, default images) so
  // plugins are self-contained and the core needs no per-format assets.
  router.get('/plugin-assets/:id/*path', (req, res, ctx) => {
    const plugin = ctx.registry?.get?.(ctx.params.id);
    if (!plugin?.assets) throw new HttpError(404, 'Not found');
    const rel = safeMember(ctx.params.path);
    if (rel == null) throw new HttpError(404, 'Not found');
    const abs = path.join(plugin.assets, rel);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const type = CONTENT_TYPES[path.extname(abs)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': ctx.dev ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(abs).pipe(res);
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
