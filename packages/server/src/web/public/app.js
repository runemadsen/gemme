// Vanilla Web Component islands + small page glue. No framework, no build step.
//
// The asset grid is a pure function of (query -> items). Two things trigger a
// re-render, both funnelling through <archive-assets>.refresh():
//   • query changes  — <archive-search> dispatches `archive:query`
//   • data changes   — an upload (`archive:changed`) or a server-sent `change`
//                       event on /api/events (extraction finished, delete, …)
// Rendering uses keyed reconciliation so unchanged cards (and their already-
// loaded thumbnails) are left untouched.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// Must match cardSig() in web/render.js.
function cardSig(item) {
  return [item.thumbnail_type || '', item.current_version_id, item.extraction_status, item.byte_size, item.original_filename].join('|');
}

// Inner markup, shared shape with render.js `cardInner`.
function cardInner(item) {
  const pending = item.extraction_status === 'pending';
  const thumb = item.thumbnail_type
    ? `<div class="thumb"><img loading="lazy" src="/api/assets/${item.id}/thumbnail?v=${item.current_version_id}" alt=""></div>`
    : `<div class="thumb"><div class="filetype">${esc((item.mime_type || 'file').split('/').pop())}</div></div>`;
  return `${thumb}<div class="meta">
    <div class="name" title="${esc(item.original_filename)}">${esc(item.original_filename)}</div>
    <div class="sub">${esc(fmtSize(item.byte_size))}${pending ? ' · <span class="badge">processing…</span>' : ''}</div>
  </div>`;
}

function makeCard(item) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `/assets/${item.id}`;
  a.dataset.id = String(item.id);
  a.dataset.sig = cardSig(item);
  a.innerHTML = cardInner(item);
  return a;
}

function updateCard(el, item) {
  el.dataset.sig = cardSig(item);
  el.href = `/assets/${item.id}`;
  el.innerHTML = cardInner(item);
}

/**
 * Keyed reconcile: match existing cards by data-id, update only those whose
 * signature changed, insert new ones, remove gone ones, and fix order — reusing
 * DOM nodes so unchanged thumbnails don't reload.
 */
function reconcile(grid, items) {
  if (!items.length) {
    grid.innerHTML = `<p class="empty">No matches.</p>`;
    return;
  }
  // Drop any non-card placeholder (empty/error message) currently shown.
  for (const child of [...grid.children]) {
    if (!child.dataset || !child.dataset.id) child.remove();
  }
  const existing = new Map([...grid.children].map((el) => [el.dataset.id, el]));
  const seen = new Set();
  for (const item of items) {
    const id = String(item.id);
    seen.add(id);
    let el = existing.get(id);
    if (!el) el = makeCard(item);
    else if (el.dataset.sig !== cardSig(item)) updateCard(el, item);
    grid.appendChild(el); // moves into the correct order (no-op if already there)
  }
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
}

async function fetchItems(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return { items: [], error: (await res.json().catch(() => ({}))).error };
  return res.json();
}

// <archive-assets> — owns the grid, the current query, and live updates.
class ArchiveAssets extends HTMLElement {
  connectedCallback() {
    this.grid = this.querySelector('#results') || this.appendChild(Object.assign(document.createElement('div'), { id: 'results', className: 'grid' }));
    this.query = '';
    this.seq = 0;
    this.debounce = null;

    this.onQuery = (e) => { this.query = e.detail.query || ''; this.refresh(); };
    this.onChanged = () => this.scheduleRefresh();
    document.addEventListener('archive:query', this.onQuery);
    document.addEventListener('archive:changed', this.onChanged);
    this.connectStream();
  }

  disconnectedCallback() {
    document.removeEventListener('archive:query', this.onQuery);
    document.removeEventListener('archive:changed', this.onChanged);
    clearTimeout(this.debounce);
    this.source?.close();
  }

  // Live server pushes (extraction done, deletes from other tabs, …).
  connectStream() {
    try {
      this.source = new EventSource('/api/events');
      this.source.addEventListener('change', () => this.scheduleRefresh());
    } catch {
      /* EventSource unavailable — query-driven refresh still works */
    }
  }

  // Coalesce bursts (e.g. 20 uploads finishing extraction) into one refresh.
  scheduleRefresh() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 250);
  }

  async refresh() {
    const seq = ++this.seq;
    const data = await fetchItems(this.query);
    if (seq !== this.seq) return; // a newer refresh superseded this one
    if (data.error) {
      this.grid.innerHTML = `<p class="error">${esc(data.error)}</p>`;
      return;
    }
    reconcile(this.grid, data.items || []);
  }
}

// <archive-search> — debounced query box; broadcasts the query, renders nothing.
class ArchiveSearch extends HTMLElement {
  connectedCallback() {
    const placeholder = this.getAttribute('placeholder') || 'Search…';
    this.innerHTML = `<input type="search" class="search" placeholder="${esc(placeholder)}" autocomplete="off">`;
    const input = this.querySelector('input');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.dispatchEvent(new CustomEvent('archive:query', { detail: { query: input.value } }));
      }, 180);
    });
  }
}

// <archive-uploader> — drag/drop or pick files; one request per file, with progress.
class ArchiveUploader extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="dropzone" tabindex="0">
        <p>Drag files here, or <button type="button" class="pick">choose files</button></p>
        <input type="file" multiple hidden>
      </div>
      <ul class="upload-list"></ul>`;
    this.zone = this.querySelector('.dropzone');
    this.fileInput = this.querySelector('input[type=file]');
    this.list = this.querySelector('.upload-list');

    this.querySelector('.pick').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => this.add(this.fileInput.files));

    ['dragover', 'dragenter'].forEach((e) =>
      this.zone.addEventListener(e, (ev) => { ev.preventDefault(); this.zone.classList.add('over'); })
    );
    ['dragleave', 'drop'].forEach((e) => this.zone.addEventListener(e, () => this.zone.classList.remove('over')));
    this.zone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer?.files?.length) this.add(ev.dataTransfer.files);
    });
  }

  async add(fileList) {
    const files = [...fileList];
    let anySucceeded = false;
    await Promise.all(
      files.map(async (file) => {
        const row = document.createElement('li');
        row.textContent = `${file.name} — uploading…`;
        this.list.appendChild(row);
        try {
          await uploadFile(file, (pct) => (row.textContent = `${file.name} — ${pct}%`));
          row.textContent = `${file.name} — done`;
          row.className = 'ok';
          anySucceeded = true;
        } catch (err) {
          row.textContent = `${file.name} — failed: ${err.message}`;
          row.className = 'fail';
        }
      })
    );
    if (anySucceeded) document.dispatchEvent(new CustomEvent('archive:changed'));
  }
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText || '{}'));
      else reject(new Error(safeError(xhr.responseText) || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(file);
  });
}

function safeError(text) {
  try {
    return JSON.parse(text).error;
  } catch {
    return null;
  }
}

// --- page glue -------------------------------------------------------------

function wireLogin() {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { email: form.email.value, password: form.password.value };
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) location.href = '/';
    else
      document.getElementById('login-error').textContent =
        (await res.json().catch(() => ({}))).error || 'Sign in failed';
  });
}

function wireLogout() {
  const btn = document.getElementById('logout');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });
}

customElements.define('archive-assets', ArchiveAssets);
customElements.define('archive-search', ArchiveSearch);
customElements.define('archive-uploader', ArchiveUploader);
wireLogin();
wireLogout();
