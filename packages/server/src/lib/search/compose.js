/**
 * The single mapping between the three representations of search state, shared
 * by the server (initial render of GET /) and mirrored in the browser
 * (web/public/app.js):
 *
 *   • state   — { text, filters }   (the source of truth)
 *   • string  — a canonical query the user types/reads: `text key=v1,v2 …`
 *   • URL     — `?q=<text>` + one repeated param per facet key
 *
 * "Filters" are field clauses whose key is a known facet (ext, type, …). Typing
 * `ext:jpg` in the search bar and clicking the sidebar both resolve to the same
 * state, so both produce `?ext=jpg`.
 */

/** Metadata keys shown as checkbox facets (EAV GROUP BY). Mirrored in app.js. */
export const FACET_KEYS = ['ext', 'type'];
/** All keys recognized as filters in the query string (facets + collection). */
export const FILTER_KEYS = [...FACET_KEYS, 'collection'];

/** Sort fields (label lives in the UI). Whitelisted; mirrored in app.js. */
export const SORT_KEYS = ['date', 'name'];
export const PER_PAGE_OPTIONS = [25, 50, 100, 200];
export const DEFAULTS = { sort: 'date', direction: 'desc', page: 1, perPage: 50 };

// Param names that are NOT facet keys.
const RESERVED = new Set(['q', 'sort', 'direction', 'page', 'perPage']);

/** Clamp/whitelist the view controls, falling back to defaults. */
export function normalizeControls({ sort, direction, page, perPage } = {}) {
  const p = Math.floor(Number(page));
  const pp = Math.floor(Number(perPage));
  return {
    sort: SORT_KEYS.includes(sort) ? sort : DEFAULTS.sort,
    direction: direction === 'asc' || direction === 'desc' ? direction : DEFAULTS.direction,
    page: Number.isFinite(p) && p >= 1 ? p : DEFAULTS.page,
    // Dropdown offers PER_PAGE_OPTIONS, but the API accepts any 1..200.
    perPage: Number.isFinite(pp) && pp >= 1 ? Math.min(pp, 200) : DEFAULTS.perPage,
  };
}

/** URLSearchParams -> { text, filters, sort, direction, page, perPage }. */
export function resolveState(searchParams, facetKeys = FACET_KEYS) {
  const q = searchParams.get('q') || '';
  const fromParams = {};
  for (const key of new Set(searchParams.keys())) {
    if (RESERVED.has(key)) continue;
    const values = searchParams.getAll(key).filter((v) => v !== '');
    if (values.length) fromParams[key] = values;
  }
  // A facet command sitting in `q` (e.g. a hand-typed ?q=ext:jpg) is folded into
  // filters so it renders identically to ?ext=jpg.
  const { text, filters: fromText } = parseQueryString(q, FILTER_KEYS);
  const controls = normalizeControls({
    sort: searchParams.get('sort'),
    direction: searchParams.get('direction'),
    page: searchParams.get('page'),
    perPage: searchParams.get('perPage'),
  });
  return { text, filters: mergeFilters(fromParams, fromText), ...controls };
}

/** Parse a typed query string into { text, filters }, extracting facet commands. */
export function parseQueryString(input, facetKeys = FILTER_KEYS) {
  const keys = new Set(facetKeys);
  const filters = {};
  const rest = [];
  for (const tok of tokenizeQuery(input || '')) {
    const m = /^([A-Za-z_][\w.]*)[:=](.*)$/.exec(tok); // key:value or key=value (unquoted key, no leading -)
    if (m && keys.has(m[1])) {
      const values = splitList(m[2]);
      if (values.length) filters[m[1]] = mergeValues(filters[m[1]] || [], values);
    } else {
      rest.push(tok);
    }
  }
  return { text: rest.join(' ').trim(), filters };
}

/** { text, filters } -> canonical query string (also the DSL we execute). */
export function composeQuery(text, filters) {
  const parts = [];
  const t = (text || '').trim();
  if (t) parts.push(t);
  for (const [key, values] of Object.entries(filters || {})) {
    if (values && values.length) parts.push(`${key}=${values.map(quoteValue).join(',')}`);
  }
  return parts.join(' ');
}

/**
 * Full state -> URLSearchParams string body (no leading '?'). Only non-default
 * controls are serialized, keeping filter-only URLs clean.
 */
export function stateToUrl(state = {}) {
  const { text = '', filters = {} } = state;
  const sp = new URLSearchParams();
  const t = (text || '').trim();
  if (t) sp.set('q', t);
  for (const [key, values] of Object.entries(filters)) for (const v of values) sp.append(key, v);
  const c = normalizeControls(state);
  if (c.sort !== DEFAULTS.sort) sp.set('sort', c.sort);
  if (c.direction !== DEFAULTS.direction) sp.set('direction', c.direction);
  if (c.page !== DEFAULTS.page) sp.set('page', String(c.page));
  if (c.perPage !== DEFAULTS.perPage) sp.set('perPage', String(c.perPage));
  return sp.toString();
}

// --- helpers ---------------------------------------------------------------

function mergeFilters(a, b) {
  const out = { ...a };
  for (const [key, values] of Object.entries(b)) out[key] = mergeValues(out[key] || [], values);
  return out;
}

function mergeValues(a, b) {
  const seen = new Set(a);
  return [...a, ...b.filter((v) => !seen.has(v) && (seen.add(v), true))];
}

function splitList(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) return [raw.slice(1, -1)];
  return raw
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s.length >= 2 && s[0] === '"' && s.endsWith('"') ? s.slice(1, -1) : s))
    .filter((s) => s.length > 0);
}

function quoteValue(v) {
  const s = String(v);
  return s === '' || /[\s,"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

/** Whitespace-split, keeping "quoted segments" (incl. spaces) intact. */
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
        tok += '"';
        i++;
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
