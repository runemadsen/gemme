/**
 * Server-side HTML rendering. Pages are complete, useful-without-JS documents;
 * interactivity is layered on by the Web Component islands in /static/app.js.
 */

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

function layout({ title, user, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Archive</title>
<link rel="stylesheet" href="/static/styles.css">
<script type="module" src="/static/app.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">Archive</a>
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

export function renderHome({ user, result }) {
  return layout({
    title: 'Archive',
    user,
    body: `<archive-uploader></archive-uploader>
<archive-search placeholder="Search — e.g. type:image width>1920 mountains"></archive-search>
<archive-assets><div id="results" class="grid">${renderGrid(result.items)}</div></archive-assets>`,
  });
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
    item.current_version_id,
    item.extraction_status,
    item.byte_size,
    item.original_filename,
  ].join('|');
}

export function renderCard(item) {
  return `<a class="card" data-id="${item.id}" data-sig="${escapeHtml(cardSig(item))}" href="/assets/${item.id}">${cardInner(item)}</a>`;
}

// Inner markup of a card, shared shape with public/app.js `cardInner`.
function cardInner(item) {
  const pending = item.extraction_status === 'pending';
  const thumb = item.thumbnail_type
    ? `<div class="thumb"><img loading="lazy" src="/api/assets/${item.id}/thumbnail?v=${item.current_version_id}" alt=""></div>`
    : `<div class="thumb"><div class="filetype">${escapeHtml((item.mime_type || 'file').split('/').pop())}</div></div>`;
  return `${thumb}<div class="meta">
    <div class="name" title="${escapeHtml(item.original_filename)}">${escapeHtml(item.original_filename)}</div>
    <div class="sub">${escapeHtml(fmtSize(item.byte_size))}${pending ? ' · <span class="badge">processing…</span>' : ''}</div>
  </div>`;
}

export function renderDetail({ user, asset, metadata }) {
  const isImage = /^image\//.test(
    asset.versions.find((v) => v.is_current)?.mime_type || ''
  );
  const preview = isImage
    ? `<img src="/api/assets/${asset.id}/download" alt="">`
    : '';
  const metaRows = metadata.length
    ? metadata
        .map(
          (m) =>
            `<tr><td>${escapeHtml(m.key)}</td><td>${escapeHtml(m.value_text ?? m.value_num)}</td><td class="src">${escapeHtml(m.source)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="3" class="empty">No metadata extracted yet.</td></tr>`;
  const versions = asset.versions
    .map(
      (v) => `<li>
    <a href="/api/assets/${asset.id}/versions/${v.id}/download">v${v.version_no}</a>
    ${v.is_current ? '<span class="badge">current</span>' : ''}
    <span class="sub">${escapeHtml(fmtSize(v.byte_size))} · ${escapeHtml(v.mime_type || '')} · ${escapeHtml(v.created_at)}</span>
  </li>`
    )
    .join('');

  return layout({
    title: asset.original_filename,
    user,
    body: `<section class="detail">
  <p><a href="/">← Back</a></p>
  <h1>${escapeHtml(asset.original_filename)}</h1>
  <div class="preview">${preview}</div>
  <h2>Versions</h2>
  <ul class="versions">${versions}</ul>
  <h2>Metadata</h2>
  <table class="metadata"><thead><tr><th>Key</th><th>Value</th><th>Source</th></tr></thead><tbody>${metaRows}</tbody></table>
</section>`,
  });
}

export function renderNotFound({ user }) {
  return layout({ title: 'Not found', user, body: `<section class="detail"><h1>Not found</h1><p><a href="/">← Back</a></p></section>` });
}
