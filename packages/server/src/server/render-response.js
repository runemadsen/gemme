/** True if the client's If-None-Match matches, so we can 304. */
export function notModified(req, etag) {
  const inm = req.headers['if-none-match'];
  return inm != null && inm === etag;
}

/**
 * Cache policy shared by every media-serving route (authenticated downloads,
 * thumbnails, HLS bundle members, and public `/i/...`). A file IS one immutable
 * blob — its bytes are written exactly once and never change, and the by-id URL
 * (plus the transform/bundle sig) fully identifies them — so it's safe to cache
 * `immutable` (fast, zero revalidation).
 *
 * Dev mode (`ctx.dev`) never sends `immutable`: re-running extraction locally
 * rewrites a thumbnail for the *same* file, the one thing that can break the
 * promise, so it's confined to development.
 *
 * Tradeoff for the public routes: revoking public access (making a collection
 * private, or deleting the file) won't reach already-cached CDN/browser copies
 * until this max-age expires — edge access control is best-effort, the
 * deliberate cost of long-lived image caching.
 */
export function imageCacheControl(ctx) {
  return ctx.dev ? 'no-cache' : 'public, max-age=31536000, immutable';
}

/**
 * Parse an HTTP `Range: bytes=…` header against a known total size.
 * Supports `start-end`, `start-` (to EOF), and `-suffix` (last N bytes).
 * @returns {{start:number,end:number}|null|'unsatisfiable'} inclusive range,
 *   null when there's no (single-range) header, 'unsatisfiable' for 416.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // ignore multi-range / malformed → full 200
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix: last N bytes.
    const n = Number(rawEnd);
    if (n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

/**
 * Stream bytes with HTTP Range support (progressive audio/video seeking) and a
 * strong ETag. `open({start,end})` returns a Readable for the (inclusive) range;
 * called with the full range for a 200. Always advertises `Accept-Ranges: bytes`.
 *
 * @param {{size:number, contentType:string, etag:string, cacheControl:string,
 *          disposition?:string, open:(range:{start:number,end:number})=>import('node:stream').Readable}} opts
 */
export function streamBytes(req, res, { size, contentType, etag, cacheControl, disposition, open }) {
  const base = { etag, 'cache-control': cacheControl, 'accept-ranges': 'bytes' };
  if (disposition) base['content-disposition'] = disposition;

  if (notModified(req, etag)) {
    res.writeHead(304, base);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      ...base,
      'content-type': contentType,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    open({ start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'content-type': contentType, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  open({ start: 0, end: size - 1 }).pipe(res);
}
