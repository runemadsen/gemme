// Vanilla Web Component islands + small page glue. No framework, no build step.
//
// Unified search/filter model: a single `store` holds { text, filters } and is
// the source of truth. The search bar and the filter sidebar are just views of
// it, and the URL + grid derive from it. Typing `ext:jpg` and clicking the
// sidebar both resolve to the same state → the same `?ext=jpg` URL.
//   • search bar (Enter) → store.setFromString(parsed)
//   • sidebar checkbox    → store.toggleFilter(...)
//   • any store change    → rewrite URL, re-render bar + sidebar, refetch grid
// Data changes (uploads, server-sent `change`) refetch the grid without
// touching query state. Rendering uses keyed reconciliation.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// ---- cards + keyed reconciliation ----------------------------------------

function cardSig(item) {
  return [item.thumbnail_type || '', item.current_version_id, item.extraction_status, item.byte_size, item.original_filename].join('|');
}

function cardInner(item) {
  const pending = item.extraction_status === 'pending';
  const thumb = item.thumbnail_type
    ? `<div class="thumb"><img loading="lazy" src="/api/files/${item.id}/versions/${item.current_version_id}/thumbnail" alt=""></div>`
    : `<div class="thumb"><div class="filetype">${esc((item.mime_type || 'file').split('/').pop())}</div></div>`;
  return `${thumb}<div class="meta">
    <div class="name" title="${esc(item.original_filename)}">${esc(item.original_filename)}</div>
    <div class="sub">${esc(fmtSize(item.byte_size))}${pending ? ' · <span class="badge">processing…</span>' : ''}</div>
  </div>`;
}

function makeCard(item) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `/files/${item.id}`;
  a.dataset.id = String(item.id);
  a.dataset.sig = cardSig(item);
  a.innerHTML = cardInner(item);
  return a;
}

function updateCard(el, item) {
  el.dataset.sig = cardSig(item);
  el.href = `/files/${item.id}`;
  el.innerHTML = cardInner(item);
}

function reconcile(grid, items) {
  if (!items.length) {
    grid.innerHTML = `<p class="empty">No matches.</p>`;
    return;
  }
  for (const child of [...grid.children]) if (!child.dataset || !child.dataset.id) child.remove();
  const existing = new Map([...grid.children].map((el) => [el.dataset.id, el]));
  const seen = new Set();
  for (const item of items) {
    const id = String(item.id);
    seen.add(id);
    let el = existing.get(id);
    if (!el) el = makeCard(item);
    else if (el.dataset.sig !== cardSig(item)) updateCard(el, item);
    grid.appendChild(el);
  }
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
}

async function fetchResults(state) {
  const sp = new URLSearchParams();
  sp.set('q', composeQuery(state.text, state.filters));
  sp.set('sort', state.sort);
  sp.set('direction', state.direction);
  sp.set('page', String(state.page));
  sp.set('perPage', String(state.perPage));
  const res = await fetch(`/api/search?${sp.toString()}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || `HTTP ${res.status}` };
  return body;
}

// ---- query model (mirrors server search/compose.js) ----------------------

// Facet sections shown in the sidebar. Add a key here to add a filter (the
// backend facet API is key-driven). FACET_KEYS mirrors compose.js on the server.
const FACETS = [
  { key: 'ext', label: 'Extension' },
  { key: 'type', label: 'Type' },
];
const FACET_KEYS = FACETS.map((f) => f.key);
// All keys recognized as filters in the query string (facets + collection).
const FILTER_KEYS = [...FACET_KEYS, 'collection'];

// View controls (sort/pagination). Mirror compose.js on the server.
const SORT_KEYS = ['date', 'name'];
const SORT_LABELS = { date: 'Upload date', name: 'Filename' };
const PER_PAGE_OPTIONS = [25, 50, 100, 200];
const DEFAULTS = { sort: 'date', direction: 'desc', page: 1, perPage: 50 };
const RESERVED = new Set(['q', 'sort', 'direction', 'page', 'perPage']);

function normalizeControls(c = {}) {
  const p = Math.floor(Number(c.page));
  const pp = Math.floor(Number(c.perPage));
  return {
    sort: SORT_KEYS.includes(c.sort) ? c.sort : DEFAULTS.sort,
    direction: c.direction === 'asc' || c.direction === 'desc' ? c.direction : DEFAULTS.direction,
    page: Number.isFinite(p) && p >= 1 ? p : DEFAULTS.page,
    perPage: Number.isFinite(pp) && pp >= 1 ? Math.min(pp, 200) : DEFAULTS.perPage,
  };
}

function quoteValue(v) {
  const s = String(v);
  return s === '' || /[\s,"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

// { text, filters } -> canonical query string (also what we execute).
function composeQuery(text, filters) {
  const parts = [];
  const t = (text || '').trim();
  if (t) parts.push(t);
  for (const [key, values] of Object.entries(filters || {})) {
    if (values && values.length) parts.push(`${key}=${values.map(quoteValue).join(',')}`);
  }
  return parts.join(' ');
}

// Typed query string -> { text, filters }, extracting facet commands.
function parseQueryString(input, facetKeys = FILTER_KEYS) {
  const keys = new Set(facetKeys);
  const filters = {};
  const rest = [];
  for (const tok of tokenizeQuery(input || '')) {
    const m = /^([A-Za-z_][\w.]*)[:=](.*)$/.exec(tok);
    if (m && keys.has(m[1])) {
      const values = splitList(m[2]);
      if (values.length) filters[m[1]] = mergeValues(filters[m[1]] || [], values);
    } else {
      rest.push(tok);
    }
  }
  return { text: rest.join(' ').trim(), filters };
}

function splitList(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) return [raw.slice(1, -1)];
  return raw
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s.length >= 2 && s[0] === '"' && s.endsWith('"') ? s.slice(1, -1) : s))
    .filter((s) => s.length > 0);
}

function mergeValues(a, b) {
  const seen = new Set(a);
  return [...a, ...b.filter((v) => !seen.has(v) && (seen.add(v), true))];
}

function mergeFilters(a, b) {
  const out = { ...a };
  for (const [key, values] of Object.entries(b)) out[key] = mergeValues(out[key] || [], values);
  return out;
}

function tokenizeQuery(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        tok += '"'; i++;
        while (i < n && input[i] !== '"') tok += input[i++];
        if (i < n) tok += input[i++];
      } else {
        tok += input[i++];
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

function resolveUrlState() {
  const sp = new URLSearchParams(location.search);
  const fromParams = {};
  for (const key of new Set(sp.keys())) {
    if (RESERVED.has(key)) continue;
    const values = sp.getAll(key).filter((v) => v !== '');
    if (values.length) fromParams[key] = values;
  }
  const { text, filters: fromText } = parseQueryString(sp.get('q') || '');
  const controls = normalizeControls({
    sort: sp.get('sort'),
    direction: sp.get('direction'),
    page: sp.get('page'),
    perPage: sp.get('perPage'),
  });
  return { text, filters: mergeFilters(fromParams, fromText), ...controls };
}

// Full state -> URLSearchParams (only non-default controls). Mirrors stateToUrl.
function stateToParams(state) {
  const sp = new URLSearchParams();
  const t = (state.text || '').trim();
  if (t) sp.set('q', t);
  for (const [key, values] of Object.entries(state.filters || {})) for (const v of values) sp.append(key, v);
  const c = normalizeControls(state);
  if (c.sort !== DEFAULTS.sort) sp.set('sort', c.sort);
  if (c.direction !== DEFAULTS.direction) sp.set('direction', c.direction);
  if (c.page !== DEFAULTS.page) sp.set('page', String(c.page));
  if (c.perPage !== DEFAULTS.perPage) sp.set('perPage', String(c.perPage));
  return sp;
}

function urlFor(state) {
  const qs = stateToParams(state).toString();
  return qs ? `?${qs}` : location.pathname;
}

function writeUrlState(state) {
  history.replaceState(null, '', urlFor(state));
}

// ---- the store: single source of truth for search + filters --------------

const store = {
  text: '',
  filters: {},
  sort: DEFAULTS.sort,
  direction: DEFAULTS.direction,
  page: DEFAULTS.page,
  perPage: DEFAULTS.perPage,
  listeners: new Set(),
  init(state) {
    Object.assign(this, normalizeControls(state), { text: state.text, filters: state.filters });
  },
  snapshot() {
    return {
      text: this.text,
      filters: { ...this.filters },
      sort: this.sort,
      direction: this.direction,
      page: this.page,
      perPage: this.perPage,
    };
  },
  queryString() {
    return composeQuery(this.text, this.filters);
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  // Query-affecting changes reset to page 1; only setPage keeps the page.
  setFromString(str) {
    const s = parseQueryString(str);
    this.text = s.text;
    this.filters = s.filters;
    this.page = 1;
    this.commit();
  },
  toggleFilter(key, value, on) {
    const set = new Set(this.filters[key] || []);
    if (on) set.add(value);
    else set.delete(value);
    const filters = { ...this.filters };
    if (set.size) filters[key] = [...set];
    else delete filters[key];
    this.filters = filters;
    this.page = 1;
    this.commit();
  },
  setSort(v) {
    this.sort = v;
    this.page = 1;
    this.commit();
  },
  setDirection(v) {
    this.direction = v;
    this.page = 1;
    this.commit();
  },
  setPerPage(v) {
    this.perPage = Number(v);
    this.page = 1;
    this.commit();
  },
  setPage(n) {
    this.page = n;
    this.commit();
  },
  // Reflect a server-clamped page without triggering another fetch.
  adoptPage(n) {
    this.page = n;
    writeUrlState(this.snapshot());
  },
  commit() {
    writeUrlState(this.snapshot());
    for (const fn of this.listeners) fn(this.snapshot());
  },
};

// ---- components -----------------------------------------------------------

// <gemme-files> — the grid. Re-renders on query changes (store) and data
// changes (uploads / server-sent), reconciling by file id.
class GemmeFiles extends HTMLElement {
  connectedCallback() {
    this.grid = this.querySelector('#results') || this.appendChild(Object.assign(document.createElement('div'), { id: 'results', className: 'grid' }));
    this.seq = 0;
    this.debounce = null;
    // The server already rendered the grid for the current URL state, so we
    // only refetch on subsequent changes.
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.onData = () => this.scheduleRefresh();
    document.addEventListener('gemme:changed', this.onData);
    document.addEventListener('gemme:server-change', this.onData);
    connectServerEvents();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    document.removeEventListener('gemme:changed', this.onData);
    document.removeEventListener('gemme:server-change', this.onData);
    clearTimeout(this.debounce);
  }

  scheduleRefresh() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 250);
  }

  async refresh() {
    const seq = ++this.seq;
    const data = await fetchResults(store.snapshot());
    if (seq !== this.seq) return;
    if (data.error) {
      this.grid.innerHTML = `<p class="error">${esc(data.error)}</p>`;
      document.dispatchEvent(new CustomEvent('gemme:results', { detail: { page: 1, pages: 1, total: 0 } }));
      return;
    }
    reconcile(this.grid, data.items || []);
    // If the server clamped the page (e.g. filters shrank the result set),
    // adopt it without triggering another fetch.
    if (typeof data.page === 'number' && data.page !== store.page) store.adoptPage(data.page);
    document.dispatchEvent(
      new CustomEvent('gemme:results', { detail: { page: data.page, pages: data.pages, total: data.total } })
    );
  }
}

// <gemme-search> — shows the canonical query; searches only on Enter.
class GemmeSearch extends HTMLElement {
  connectedCallback() {
    const placeholder = this.getAttribute('placeholder') || 'Search…';
    this.innerHTML = `<input type="search" class="search" placeholder="${esc(placeholder)}" autocomplete="off">`;
    this.input = this.querySelector('input');
    this.render();
    this.unsubscribe = store.subscribe(() => this.render());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        store.setFromString(this.input.value);
      }
    });
  }

  disconnectedCallback() {
    this.unsubscribe?.();
  }

  render() {
    // Reflect canonical state, but don't clobber what the user is mid-typing.
    if (document.activeElement !== this.input) this.input.value = store.queryString();
  }
}

// <gemme-filters> — checkboxes reflecting store.filters; toggling updates it.
class GemmeFilters extends HTMLElement {
  connectedCallback() {
    this.facets = {};
    this.debounce = null;
    this.innerHTML = `<p class="empty">Loading…</p>`;
    this.unsubscribe = store.subscribe(() => this.render());
    this.onData = () => this.scheduleLoad();
    document.addEventListener('gemme:changed', this.onData);
    document.addEventListener('gemme:server-change', this.onData);
    this.load();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    document.removeEventListener('gemme:changed', this.onData);
    document.removeEventListener('gemme:server-change', this.onData);
    clearTimeout(this.debounce);
  }

  scheduleLoad() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.load(), 400);
  }

  async load() {
    const res = await fetch(`/api/facets?keys=${encodeURIComponent(FACET_KEYS.join(','))}`);
    if (!res.ok) return;
    this.facets = (await res.json()).facets || {};
    this.render();
  }

  render() {
    const { filters } = store.snapshot();
    const sections = FACETS.map((f) => this.section(f, filters)).filter(Boolean);
    this.innerHTML = sections.join('') || '<p class="empty">No filters yet.</p>';
    this.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', () => store.toggleFilter(cb.dataset.key, cb.value, cb.checked))
    );
  }

  section(facet, filters) {
    const values = this.facets[facet.key] || [];
    if (!values.length) return '';
    const sel = new Set(filters[facet.key] || []);
    const opts = values
      .map((v) => {
        const val = v.value ?? '';
        const label = val === '' ? '(none)' : val;
        return `<label class="facet-opt">
          <input type="checkbox" data-key="${esc(facet.key)}" value="${esc(val)}" ${sel.has(val) ? 'checked' : ''}>
          <span class="facet-name">${esc(label)}</span><span class="count">${v.count}</span>
        </label>`;
      })
      .join('');
    return `<section class="facet"><h3>${esc(facet.label)}</h3>${opts}</section>`;
  }
}

// <gemme-controls> — sort / direction / per-page selects (server-rendered
// markup; we attach handlers and keep the values synced to the store).
class GemmeControls extends HTMLElement {
  connectedCallback() {
    this.selects = {};
    for (const sel of this.querySelectorAll('select[data-control]')) {
      this.selects[sel.dataset.control] = sel;
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (sel.dataset.control === 'sort') store.setSort(v);
        else if (sel.dataset.control === 'direction') store.setDirection(v);
        else if (sel.dataset.control === 'perPage') store.setPerPage(v);
      });
    }
    this.unsubscribe = store.subscribe((s) => this.sync(s));
    this.sync(store.snapshot());
  }
  disconnectedCallback() {
    this.unsubscribe?.();
  }
  sync(s) {
    if (this.selects.sort) this.selects.sort.value = s.sort;
    if (this.selects.direction) this.selects.direction.value = s.direction;
    if (this.selects.perPage) this.selects.perPage.value = String(s.perPage);
  }
}

// <gemme-pager> — numbered links + Prev/Next. Initial page/pages come from
// server-rendered data attributes; updates arrive via `gemme:results`.
class GemmePager extends HTMLElement {
  connectedCallback() {
    this.page = Number(this.dataset.page) || 1;
    this.pages = Number(this.dataset.pages) || 1;
    this.onResults = (e) => {
      this.page = e.detail.page || 1;
      this.pages = e.detail.pages || 1;
      this.render();
    };
    document.addEventListener('gemme:results', this.onResults);
    this.addEventListener('click', (e) => {
      const link = e.target.closest('a.page[data-page]');
      if (!link) return;
      e.preventDefault();
      store.setPage(Number(link.dataset.page));
    });
    // Server already rendered the initial pager markup; leave it in place.
  }
  disconnectedCallback() {
    document.removeEventListener('gemme:results', this.onResults);
  }
  render() {
    this.innerHTML = pagerHtml(this.page, this.pages);
  }
}

function pageWindow(page, pages, radius = 2) {
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

function pagerHtml(page, pages) {
  if (pages <= 1) return '';
  const s = store.snapshot();
  const href = (n) => urlFor({ ...s, page: n });
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

// Build a sorted tree (roots[]) from the flat collections list.
function buildTree(list) {
  const byId = new Map(list.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    if (c.parent_id != null && byId.has(c.parent_id)) byId.get(c.parent_id).children.push(c);
    else roots.push(c);
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

async function fetchCollections() {
  const res = await fetch('/api/collections');
  return res.ok ? (await res.json()).collections : [];
}

// <gemme-collections> — sidebar tree; multi-select by NAME drives the filter.
class GemmeCollections extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<h2>Collections</h2><div class="tree"><p class="empty">Loading…</p></div>`;
    this.treeEl = this.querySelector('.tree');
    this.unsubscribe = store.subscribe(() => this.markSelected());
    this.onData = () => this.scheduleLoad();
    document.addEventListener('gemme:changed', this.onData);
    document.addEventListener('gemme:server-change', this.onData);
    this.load();
  }
  disconnectedCallback() {
    this.unsubscribe?.();
    document.removeEventListener('gemme:changed', this.onData);
    document.removeEventListener('gemme:server-change', this.onData);
    clearTimeout(this.debounce);
  }
  scheduleLoad() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.load(), 400);
  }
  async load() {
    this.roots = buildTree(await fetchCollections());
    this.render();
  }
  render() {
    if (!this.roots.length) {
      this.treeEl.innerHTML = `<p class="empty">No collections yet.</p>`;
      return;
    }
    const sel = new Set(store.snapshot().filters.collection || []);
    this.treeEl.innerHTML = `<ul class="ctree">${this.roots.map((n) => node(n, sel)).join('')}</ul>`;
    this.treeEl.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', () => store.toggleFilter('collection', cb.value, cb.checked))
    );
    this.treeEl.querySelectorAll('.ctoggle').forEach((t) =>
      t.addEventListener('click', () => t.closest('li').classList.toggle('collapsed'))
    );
  }
  markSelected() {
    const sel = new Set(store.snapshot().filters.collection || []);
    this.treeEl?.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = sel.has(cb.value)));
  }
}

// A tree node for the sidebar (checkbox keyed by NAME).
function node(n, sel) {
  const hasKids = n.children.length > 0;
  const toggle = hasKids ? `<button class="ctoggle" type="button" aria-label="collapse">▾</button>` : `<span class="cspacer"></span>`;
  const kids = hasKids ? `<ul>${n.children.map((c) => node(c, sel)).join('')}</ul>` : '';
  return `<li>
    <div class="crow">${toggle}
      <label class="cname"><input type="checkbox" value="${esc(n.name)}" ${sel.has(n.name) ? 'checked' : ''}> <span>${esc(n.name)}</span></label>
      <span class="count">${n.fileCount}</span>
    </div>${kids}</li>`;
}

// <gemme-file-collections> — membership checkboxes (by id) on the detail page.
class GemmeFileCollections extends HTMLElement {
  async connectedCallback() {
    this.fileId = Number(this.dataset.file);
    this.innerHTML = `<p class="empty">Loading…</p>`;
    await this.load();
  }
  async load() {
    const [collections, memRes] = await Promise.all([
      fetchCollections(),
      fetch(`/api/files/${this.fileId}/collections`).then((r) => (r.ok ? r.json() : { collectionIds: [] })),
    ]);
    this.member = new Set(memRes.collectionIds);
    this.roots = buildTree(collections);
    this.render();
  }
  render() {
    if (!this.roots.length) {
      this.innerHTML = `<p class="empty">No collections yet. Create some on the <a href="/collections">Collections</a> page.</p>`;
      return;
    }
    const mnode = (n) =>
      `<li><label class="cname"><input type="checkbox" data-id="${n.id}" ${this.member.has(n.id) ? 'checked' : ''}> <span>${esc(n.name)}</span></label>${n.children.length ? `<ul>${n.children.map(mnode).join('')}</ul>` : ''}</li>`;
    this.innerHTML = `<ul class="ctree">${this.roots.map(mnode).join('')}</ul>`;
    this.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => this.toggle(cb)));
  }
  async toggle(cb) {
    const id = Number(cb.dataset.id);
    const res = cb.checked
      ? await fetch(`/api/files/${this.fileId}/collections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collectionId: id }),
        })
      : await fetch(`/api/files/${this.fileId}/collections/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (cb.checked) this.member.add(id);
      else this.member.delete(id);
      document.dispatchEvent(new CustomEvent('gemme:changed')); // refresh counts elsewhere
    } else {
      cb.checked = !cb.checked;
    }
  }
}

// <gemme-collection-manager> — CRUD tree on the /collections page.
class GemmeCollectionManager extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<p class="empty">Loading…</p>`;
    this.load();
  }
  async load() {
    this.list = await fetchCollections();
    this.roots = buildTree(this.list);
    this.render();
  }
  render() {
    const rootOpts = `<option value="">(root)</option>` + this.list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    this.innerHTML = `
      <form class="cnew">
        <input name="cname" placeholder="New collection name" required>
        <select name="cparent">${rootOpts}</select>
        <button type="submit">Create</button>
      </form>
      <ul class="ctree manage">${this.roots.map((n) => this.node(n)).join('')}</ul>`;
    this.querySelector('.cnew').addEventListener('submit', (e) => this.create(e));
    this.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b)));
    this.querySelectorAll('select[data-move]').forEach((s) => s.addEventListener('change', () => this.move(s)));
  }
  node(n) {
    const moveOpts =
      `<option value="">(root)</option>` +
      this.list.filter((c) => c.id !== n.id).map((c) => `<option value="${c.id}" ${n.parent_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const kids = n.children.length ? `<ul>${n.children.map((c) => this.node(c)).join('')}</ul>` : '';
    return `<li><div class="crow manage">
      <span class="cname">${esc(n.name)}</span><span class="count">${n.fileCount}</span>
      <select data-move="${n.id}" title="Move to parent">${moveOpts}</select>
      <button type="button" data-act="rename" data-id="${n.id}">Rename</button>
      <button type="button" data-act="delete" data-id="${n.id}">Delete</button>
    </div>${kids}</li>`;
  }
  async create(e) {
    e.preventDefault();
    const name = e.target.cname.value.trim();
    if (!name) return;
    const parentId = e.target.cparent.value ? Number(e.target.cparent.value) : null;
    await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId }) });
    await this.load();
  }
  async act(b) {
    const id = Number(b.dataset.id);
    if (b.dataset.act === 'rename') {
      const name = prompt('New name:');
      if (name && name.trim())
        await fetch(`/api/collections/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    } else if (b.dataset.act === 'delete') {
      if (!confirm('Delete this collection and all its sub-collections? Files are not deleted.')) return;
      await fetch(`/api/collections/${id}`, { method: 'DELETE' });
    }
    await this.load();
  }
  async move(s) {
    const id = Number(s.dataset.move);
    const parentId = s.value ? Number(s.value) : null;
    const res = await fetch(`/api/collections/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId }) });
    if (!res.ok) alert((await res.json().catch(() => ({}))).error || 'Move failed');
    await this.load();
  }
}

// <gemme-uploader> — drag/drop or pick files (one request per file, with
// progress), then file the just-uploaded batch into collections by clicking the
// tree. Each new drop starts a fresh round: the file list, the batch of file
// ids, and the collection selection all reset, so uploading over many rounds
// always assigns collections to just the most recent batch.
class GemmeUploader extends HTMLElement {
  connectedCallback() {
    this.round = 0; // bumps every add(); stale in-flight uploads bail on mismatch
    this.batch = []; // file ids created/resolved in the current round
    this.selected = new Set(); // collection ids applied to the current batch
    this.innerHTML = `
      <div class="dropzone" tabindex="0">
        <p>Drag files here, or <button type="button" class="pick">choose files</button></p>
        <input type="file" multiple hidden>
      </div>
      <ul class="upload-list"></ul>
      <section class="assign" hidden>
        <h2>Add to collections</h2>
        <p class="assign-hint sub"></p>
        <div class="assign-tree"><p class="empty">Loading…</p></div>
      </section>`;
    this.zone = this.querySelector('.dropzone');
    this.fileInput = this.querySelector('input[type=file]');
    this.list = this.querySelector('.upload-list');
    this.assign = this.querySelector('.assign');
    this.assignHint = this.querySelector('.assign-hint');
    this.assignTree = this.querySelector('.assign-tree');

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

    this.loadCollections();
  }

  async loadCollections() {
    this.roots = buildTree(await fetchCollections());
    this.renderTree();
  }

  renderTree() {
    if (!this.roots || !this.roots.length) {
      this.assignTree.innerHTML = `<p class="empty">No collections yet. Create some on the <a href="/collections">Collections</a> page.</p>`;
      return;
    }
    const cnode = (n) =>
      `<li><label class="cname"><input type="checkbox" data-id="${n.id}" ${this.selected.has(n.id) ? 'checked' : ''}> <span>${esc(n.name)}</span></label>${n.children.length ? `<ul>${n.children.map(cnode).join('')}</ul>` : ''}</li>`;
    this.assignTree.innerHTML = `<ul class="ctree">${this.roots.map(cnode).join('')}</ul>`;
    this.assignTree.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', () => this.toggleCollection(cb))
    );
  }

  // Show/hide the collection tree and update its hint for the current batch.
  syncAssign() {
    const n = this.batch.length;
    this.assign.hidden = n === 0;
    if (n > 0) this.assignHint.textContent = `Add ${n} uploaded file${n === 1 ? '' : 's'} to collections:`;
  }

  async add(fileList) {
    const round = ++this.round;
    // Fresh round: clear the previous batch, selection, and file list.
    this.batch = [];
    this.selected = new Set();
    this.list.innerHTML = '';
    this.renderTree();
    this.syncAssign();

    const files = [...fileList];
    let anyCreated = false;
    await Promise.all(
      files.map(async (file) => {
        const row = document.createElement('li');
        row.textContent = `${file.name} — uploading…`;
        this.list.appendChild(row);
        try {
          const result = await uploadFile(file, (pct) => (row.textContent = `${file.name} — ${pct}%`));
          if (this.round !== round) return; // superseded by a newer round
          if (result.skipped) {
            row.textContent = `${file.name} — skipped (already imported)`;
            row.className = 'skip';
          } else {
            row.textContent = `${file.name} — done`;
            row.className = 'ok';
            anyCreated = true;
          }
          // Include both created and skipped files so a dropped duplicate can
          // still be filed into a collection.
          const id = result.file?.id;
          if (id != null) {
            this.batch.push(id);
            this.syncAssign();
            // If a collection was already ticked mid-upload, file this one too.
            for (const cid of this.selected) this.postMembership(id, cid);
          }
        } catch (err) {
          if (this.round !== round) return;
          row.textContent = `${file.name} — failed: ${err.message}`;
          row.className = 'fail';
        }
      })
    );
    if (this.round !== round) return;
    if (anyCreated) document.dispatchEvent(new CustomEvent('gemme:changed'));
    this.syncAssign();
  }

  // Ticking a collection files (or unfiles) every file in the current batch.
  async toggleCollection(cb) {
    const cid = Number(cb.dataset.id);
    const on = cb.checked;
    if (on) this.selected.add(cid);
    else this.selected.delete(cid);
    const ids = [...this.batch];
    const results = await Promise.all(
      ids.map((fileId) => (on ? this.postMembership(fileId, cid) : this.deleteMembership(fileId, cid)))
    );
    if (results.some((ok) => !ok)) {
      cb.checked = !on; // revert on any failure
      if (on) this.selected.delete(cid);
      else this.selected.add(cid);
    } else {
      document.dispatchEvent(new CustomEvent('gemme:changed')); // refresh counts elsewhere
    }
  }

  async postMembership(fileId, collectionId) {
    const res = await fetch(`/api/files/${fileId}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionId }),
    });
    return res.ok;
  }

  async deleteMembership(fileId, collectionId) {
    const res = await fetch(`/api/files/${fileId}/collections/${collectionId}`, { method: 'DELETE' });
    return res.ok;
  }
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
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

// One shared SSE connection per page; re-broadcast as a document event.
let serverEventsStarted = false;
function connectServerEvents() {
  if (serverEventsStarted) return;
  serverEventsStarted = true;
  try {
    const source = new EventSource('/api/events');
    source.addEventListener('change', (e) => {
      document.dispatchEvent(new CustomEvent('gemme:server-change', { detail: safeJson(e.data) }));
    });
  } catch {
    serverEventsStarted = false;
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---- page glue ------------------------------------------------------------

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

// Initialize the store from the URL before components upgrade and read it.
store.init(resolveUrlState());

customElements.define('gemme-files', GemmeFiles);
customElements.define('gemme-search', GemmeSearch);
customElements.define('gemme-filters', GemmeFilters);
customElements.define('gemme-collections', GemmeCollections);
customElements.define('gemme-file-collections', GemmeFileCollections);
customElements.define('gemme-collection-manager', GemmeCollectionManager);
customElements.define('gemme-controls', GemmeControls);
customElements.define('gemme-pager', GemmePager);
customElements.define('gemme-uploader', GemmeUploader);
wireLogin();
wireLogout();
