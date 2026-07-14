/**
 * The search/filter DSL — the headline feature.
 *
 * A query is whitespace-separated terms. Each term is either:
 *   - a field clause:  key <op> value   (ops: :  =  !=  >  <  >=  <=)
 *   - a free-text term: a bare or "quoted" word, matched against the full-text
 *     index (tokenized filename + extracted body) OR as a filename substring
 * Any term may be negated with a leading `-`.
 *
 * Examples:
 *   mountains type:image width>1920 created>2024-01-01
 *   filename:trip -type:pdf "exact phrase" duration>10s size>1mb
 *
 * `:` means "contains" for text values and "equals" for numeric/date values;
 * `=` is always exact. Comparison ops (> < >= <=) require a numeric or date
 * value. Values may carry units (s/min/h/d, b/kb/mb/gb/tb) which are normalized.
 */

const FIELD_RE = /^([A-Za-z_][\w.]*)(>=|<=|!=|[:=<>])([\s\S]*)$/;

const TIME_UNITS = { ms: 0.001, s: 1, sec: 1, min: 60, h: 3600, hr: 3600, d: 86400 };
const BYTE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

export class QueryError extends Error {}

/** Split a query string into tokens, keeping "quoted segments" intact. */
export function tokenize(input) {
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
        if (i < n) tok += input[i++]; // closing quote
      } else {
        tok += input[i++];
      }
    }
    tokens.push(tok);
  }
  return tokens;
}

/** Parse a query string into structured clauses + free-text terms. */
export function parseQuery(input) {
  const clauses = [];
  const text = [];
  for (let raw of tokenize(input || '')) {
    let negate = false;
    if (raw.length > 1 && raw[0] === '-') {
      negate = true;
      raw = raw.slice(1);
    }
    const m = FIELD_RE.exec(raw);
    if (m) {
      const [, key, op, rawValue] = m;
      // A comma-separated (unquoted) value is a list: OR within the field, e.g.
      // `ext=jpg,png` or `type=image,video`. Quote a value to keep commas literal.
      clauses.push({ key, op, values: splitValues(rawValue), negate });
    } else {
      const term = stripQuotes(raw);
      if (term) text.push({ term, negate });
    }
  }
  return { clauses, text };
}

/** Classify a raw value string into a typed value. */
export function parseValue(raw) {
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw)) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return { kind: 'date', num: ms, text: raw };
  }
  const num = /^(-?\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(raw);
  if (num) {
    const base = Number(num[1]);
    const unit = num[2]?.toLowerCase();
    if (!unit) return { kind: 'number', num: base, text: raw };
    const factor = TIME_UNITS[unit] ?? BYTE_UNITS[unit];
    if (factor !== undefined) return { kind: 'number', num: base * factor, text: raw };
    // unknown unit -> treat as text
  }
  return { kind: 'text', text: raw };
}

/**
 * Compile a parsed query into SQL WHERE fragments (referencing `v.id`, the
 * current version) plus bound params. Returns { conditions: string[], params }.
 */
export function compileQuery(parsed) {
  const conditions = [];
  const params = [];

  for (const clause of parsed.clauses) {
    const { sql, params: p } = compileClause(clause);
    conditions.push(sql);
    params.push(...p);
  }

  // Free-text terms (ANDed). Each matches if the term appears in the full-text
  // index (tokenized filename + extracted body) OR as a substring of the
  // filename — so a bare `DSC` finds `DSC01234.JPG` even though FTS tokenizes
  // that into the single token `dsc01234`.
  for (const t of parsed.text) {
    const { sql, params: p } = compileTextTerm(t);
    conditions.push(sql);
    params.push(...p);
  }

  return { conditions, params };
}

function compileTextTerm({ term, negate }) {
  const fts = 'v.id IN (SELECT version_id FROM metadata_fts WHERE metadata_fts MATCH ?)';
  const filenameSubstr =
    "EXISTS (SELECT 1 FROM version_metadata m WHERE m.version_id = v.id AND m.key = 'filename' AND m.value_text LIKE ? ESCAPE '\\')";
  const combined = `(${fts} OR ${filenameSubstr})`;
  const params = [ftsPhrase(term), `%${escapeLike(term)}%`];
  return { sql: negate ? `NOT ${combined}` : combined, params };
}

function compileClause({ key, op, values, negate }) {
  // `collection` is not EAV metadata — it matches files in any collection with
  // one of the given NAMES, or in any descendant of such a collection (via the
  // closure table). Duplicate names naturally union.
  if (key === 'collection') {
    const names = values.map((v) => v.text);
    const placeholders = names.map(() => '?').join(', ');
    const exists = `EXISTS (SELECT 1 FROM file_collections ac
        JOIN collection_closure cc ON cc.descendant = ac.collection_id
        JOIN collections anc ON anc.id = cc.ancestor
       WHERE ac.file_id = a.id AND anc.name IN (${placeholders}))`;
    return { sql: negate ? `NOT ${exists}` : exists, params: names };
  }

  const params = [key];
  const frags = [];
  for (const value of values) {
    const { frag, params: p } = valueCondition(op, value);
    frags.push(frag);
    params.push(...p);
  }
  // OR the per-value conditions: the field matches if ANY selected value matches.
  const cond = frags.length > 1 ? `(${frags.join(' OR ')})` : frags[0];

  const exists = `EXISTS (SELECT 1 FROM version_metadata m WHERE m.version_id = v.id AND m.key = ? AND ${cond})`;
  // `!=` negates the match; a leading `-` negates the whole term; they compose.
  const finalNegate = (op === '!=') !== negate;
  return { sql: finalNegate ? `NOT ${exists}` : exists, params };
}

/** SQL fragment + params for matching one value under an operator. */
function valueCondition(op, value) {
  const numeric = value.kind === 'number' || value.kind === 'date';
  if (op === '>' || op === '<' || op === '>=' || op === '<=') {
    if (!numeric) throw new QueryError(`Operator '${op}' needs a numeric or date value (got '${value.text}')`);
    return { frag: `m.value_num ${op} ?`, params: [value.num] };
  }
  if (op === ':' && !numeric) {
    return { frag: "m.value_text LIKE ? ESCAPE '\\'", params: [`%${escapeLike(value.text)}%`] };
  }
  if (numeric) return { frag: 'm.value_num = ?', params: [value.num] };
  return { frag: 'm.value_text = ?', params: [value.text] };
}

/**
 * Split a raw field value into a list of typed values. An unquoted value with
 * commas becomes multiple values (OR); a fully-quoted value stays a single
 * literal (commas included).
 */
function splitValues(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) return [parseValue(stripQuotes(raw))];
  return raw.split(',').map((part) => {
    const p = part.trim();
    return parseValue(p.length >= 2 && p[0] === '"' && p.endsWith('"') ? stripQuotes(p) : p);
  });
}

function ftsPhrase(term) {
  return `"${term.replace(/"/g, '')}"`;
}

function stripQuotes(s) {
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;
}

function escapeLike(s) {
  return s.replace(/[%_\\]/g, '\\$&');
}
