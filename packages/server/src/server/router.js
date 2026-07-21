/**
 * Tiny path router for node:http. Patterns use `:name` (single segment, no
 * slashes) and `*name` (catch-all, slash-allowing, must be last) tokens, e.g.
 * `/api/files/:id` or `/i/:id/*rest`. Matched params are passed to the
 * handler on `ctx.params`.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, ...compile(pattern), handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  patch(p, h) {
    return this.add('PATCH', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  /**
   * Find a handler for a method+pathname.
   * @returns {{handler: Function, params: object}|null}
   */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    // Distinguish 404 (no path) from 405 (path exists, wrong method).
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function compile(pattern) {
  const keys = [];
  const regexStr = pattern
    // Escape regex metachars, but not the token markers ':'/'*' or '/'.
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // Single pass so params are captured in left-to-right pattern order:
    // `:name` → one segment, `*name` → catch-all (may contain slashes).
    .replace(/([:*])([A-Za-z_][A-Za-z0-9_]*)/g, (_, kind, key) => {
      keys.push(key);
      return kind === '*' ? '(.+)' : '([^/]+)';
    });
  return { keys, regex: new RegExp(`^${regexStr}/?$`) };
}
