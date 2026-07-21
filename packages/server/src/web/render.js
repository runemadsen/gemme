/**
 * Server-side HTML rendering. Pages are complete, useful-without-JS documents;
 * interactivity is layered on by the Web Component islands in /static/app.js.
 */
import { stateToUrl, SORT_KEYS, PER_PAGE_OPTIONS } from '../lib/search/compose.js';

const SORT_LABELS = { date: 'Upload date', name: 'Filename' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function fmtSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function layout({ title, user, body, nav = null }) {
  const link = (href, label, key) =>
    `<a href="${href}"${nav === key ? ' class="active"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Gemme</title>
<link rel="stylesheet" href="/static/styles.css">
<script type="module" src="/static/app.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><span class="mark"></span>Gemme</a>
  ${user ? `<nav class="nav">${link('/', 'Files', 'files')}${link('/upload', 'Upload', 'upload')}${link('/collections', 'Collections', 'collections')}</nav>` : ''}
  ${user ? `<div class="user"><span>${escapeHtml(user.email)}</span><button id="logout">Log out</button></div>` : ''}
</header>
<main>${body}</main>
</body>
</html>`;
}

export function renderLogin({ error } = {}) {
  return layout({
    title: 'Sign in',
    user: null,
    body: `<section class="auth">
  <h1>Sign in</h1>
  <form id="login-form">
    <label>Email <input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
    <p class="error" id="login-error">${error ? escapeHtml(error) : ''}</p>
  </form>
</section>`,
  });
}

export function renderHome({ user, result, state }) {
  return layout({
    title: 'Gemme',
    user,
    nav: 'files',
    body: `<div class="layout">
  <aside class="sidebar"><gemme-collections></gemme-collections><gemme-filters></gemme-filters></aside>
  <div class="content">
    <gemme-search placeholder="Search — e.g. type:image width>1920 mountains"></gemme-search>
    <div class="toolbar"><gemme-controls>${renderControls(result)}</gemme-controls></div>
    <gemme-files><div id="results" class="grid">${renderGrid(result.items)}</div></gemme-files>
    <gemme-pager data-page="${result.page}" data-pages="${result.pages}">${renderPager(state, result)}</gemme-pager>
  </div>
</div>`,
  });
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

/** Sort / direction / per-page selects reflecting the current state. */
export function renderControls(state) {
  const sort = SORT_KEYS.map((k) => option(k, SORT_LABELS[k] || k, state.sort === k)).join('');
  const direction = [
    ['desc', 'Descending'],
    ['asc', 'Ascending'],
  ]
    .map(([v, l]) => option(v, l, state.direction === v))
    .join('');
  const perPage = PER_PAGE_OPTIONS.map((n) => option(String(n), `${n} / page`, Number(state.perPage) === n)).join('');
  return `<label class="control">Sort <select data-control="sort">${sort}</select></label>
<label class="control">Order <select data-control="direction">${direction}</select></label>
<label class="control">Show <select data-control="perPage">${perPage}</select></label>`;
}

/** Numbered pager with Prev/Next. Empty when there's a single page. */
export function renderPager(state, result) {
  const { page, pages } = result;
  if (pages <= 1) return '';
  const href = (n) => `?${stateToUrl({ ...state, page: n })}`;
  const num = (n) =>
    n === page
      ? `<span class="page current" aria-current="page">${n}</span>`
      : `<a class="page" data-page="${n}" href="${href(n)}">${n}</a>`;
  const prev =
    page > 1
      ? `<a class="page prev" data-page="${page - 1}" href="${href(page - 1)}">‹ Prev</a>`
      : `<span class="page prev disabled">‹ Prev</span>`;
  const next =
    page < pages
      ? `<a class="page next" data-page="${page + 1}" href="${href(page + 1)}">Next ›</a>`
      : `<span class="page next disabled">Next ›</span>`;
  const nums = pageWindow(page, pages)
    .map((p) => (p === '…' ? `<span class="page gap">…</span>` : num(p)))
    .join('');
  return `<nav class="pager">${prev}${nums}${next}</nav>`;
}

/** [1, …, 4, 5, 6, …, 20] — first/last always, ±2 around current, gaps as '…'. */
export function pageWindow(page, pages, radius = 2) {
  const set = new Set([1, pages]);
  for (let p = page - radius; p <= page + radius; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

export function renderGrid(items) {
  if (!items.length) return `<p class="empty">No files yet. Drag some in above.</p>`;
  return items.map(renderCard).join('');
}

/**
 * Per-item signature: the client re-renders a card only when this changes
 * (so extraction finishing flips it and the thumbnail appears). Must match
 * `cardSig` in public/app.js.
 */
export function cardSig(item) {
  return [
    item.thumbnail_type || '',
    item.extraction_status,
    item.byte_size,
    item.original_filename,
  ].join('|');
}

export function renderCard(item) {
  return `<a class="card" data-id="${item.id}" data-sig="${escapeHtml(cardSig(item))}" href="/files/${item.id}">${cardInner(item)}</a>`;
}

// Inner markup of a card, shared shape with public/app.js `cardInner`.
function cardInner(item) {
  const pending = item.extraction_status === 'pending';
  const thumb = item.thumbnail_type
    ? `<div class="thumb"><img loading="lazy" src="/api/files/${item.id}/thumbnail" alt=""></div>`
    : `<div class="thumb"><div class="filetype">${escapeHtml((item.mime_type || 'file').split('/').pop())}</div></div>`;
  return `${thumb}<div class="meta">
    <div class="name" title="${escapeHtml(item.original_filename)}">${escapeHtml(item.original_filename)}</div>
    <div class="sub">${escapeHtml(fmtSize(item.byte_size))}${pending ? ' · <span class="badge">processing…</span>' : ''}</div>
  </div>`;
}

/**
 * Helpers handed to a plugin's `preview(file, helpers)` capability. The plugin
 * owns the detail-page preview HTML; the core only supplies safe, id-based URL
 * builders + `escapeHtml`, so it never has to know a format. `asset(name)` maps
 * to the plugin's own shipped `assets/` (see the /plugin-assets route).
 */
export function previewHelpers(plugin, file, { isPublic = false } = {}) {
  const id = file.id;
  return {
    escapeHtml,
    fmtSize,
    isPublic,
    file,
    url: {
      download: () => `/api/files/${id}/download`,
      thumbnail: () => `/api/files/${id}/thumbnail`,
      // Generic plugin-serving URLs (authenticated / public). The plugin composes
      // the subpath — the core (and this helper) know no format: `serve('w=800.webp')`,
      // `serve('master.m3u8')`, `publicServe('360p/seg_000.ts')`, …
      serve: (subpath) => `/api/files/${id}/${subpath}`,
      publicServe: (subpath) => `/i/${id}/${subpath}`,
      publicOriginal: () => `/i/${id}`,
      asset: (name) => `/plugin-assets/${plugin.id}/${name}`,
    },
  };
}

/**
 * The detail page. `preview` is HTML produced by the matching plugin's `preview`
 * capability (empty string if none) — the core never branches on file type here.
 */
export function renderDetail({ user, file, metadata, isPublic = false, preview = '', publicEmbed = '' }) {
  const metaRows = metadata.length
    ? metadata
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.key)}</td><td>${escapeHtml(m.value_text ?? m.value_num)}</td><td class="src">${escapeHtml(m.source)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="empty">No metadata extracted yet.</td></tr>`;

  // Every public file gets a stable, unauthenticated URL. The core stays
  // format-neutral: it emits only the plain `/i/:id` original + message.
  // Format-specific "how to load" snippets (image `<img>`/srcset, HLS `<video>`,
  // audio) come from the plugin's `publicEmbed` and are injected right below it.
  const publicSection = isPublic
    ? `<h2>Public URL</h2>
  <div class="public-note">
    <p class="sub">This file is in a public collection — anyone can load it without logging in:</p>
    <p><code class="url">/i/${file.id}</code></p>${publicEmbed ? `\n    ${publicEmbed}` : ''}
  </div>`
    : '';

  return layout({
    title: file.original_filename,
    user,
    nav: 'files',
    body: `<section class="detail">
  <p><a href="/">← Back</a></p>
  <h1>${escapeHtml(file.original_filename)}</h1>
  <div class="preview">${preview}</div>
  <h2>Metadata</h2>
  <table class="metadata"><thead><tr><th>Key</th><th>Value</th><th>Source</th></tr></thead><tbody>${metaRows}</tbody></table>
  <h2>Collections</h2>
  <gemme-file-collections data-file="${file.id}"></gemme-file-collections>
  ${publicSection}
</section>`,
  });
}

export function renderUploadPage({ user }) {
  return layout({
    title: 'Upload',
    user,
    nav: 'upload',
    body: `<section class="detail">
  <h1>Upload</h1>
  <p class="sub">Drop files to add them to the archive. Exact duplicates (same name and contents) are skipped.</p>
  <gemme-uploader></gemme-uploader>
  <p style="margin-top:18px"><a href="/">View files →</a></p>
</section>`,
  });
}

export function renderCollectionsPage({ user }) {
  return layout({
    title: 'Collections',
    user,
    nav: 'collections',
    body: `<section class="detail">
  <h1>Collections</h1>
  <p class="sub">Group files into a nestable tree. Deleting a collection removes its sub-collections too; files are never deleted. Making a collection <strong>public</strong> serves every file in it — and in its sub-collections — at <code>/i/:id</code> without a login.</p>
  <gemme-collection-manager></gemme-collection-manager>
</section>`,
  });
}

export function renderNotFound({ user }) {
  return layout({ title: 'Not found', user, body: `<section class="detail"><h1>Not found</h1><p><a href="/">← Back</a></p></section>` });
}
