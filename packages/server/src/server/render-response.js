import { getRendition } from '../lib/renditions.js';

/** True if the client's If-None-Match matches, so we can 304. */
export function notModified(req, etag) {
  const inm = req.headers['if-none-match'];
  return inm != null && inm === etag;
}

/**
 * Generate-or-cache a rendition and stream it, with a strong ETag
 * (`"<sourceHash>-<sig>"`) and the given Cache-Control. Shared by the public
 * `/i/...` transform route and the authenticated thumbnail routes.
 *
 * @param {{contentHash:string, mimeType?:string, filename?:string}} source
 */
export async function streamRendition(req, res, ctx, source, renderer, spec, ext, cacheControl) {
  const { sig, contentType } = await getRendition(ctx, source, renderer, spec, ext);
  const stat = ctx.derivedStore.statVariant(source.contentHash, sig, ext);
  const etag = `"${source.contentHash}-${sig}"`;
  const headers = { etag, 'cache-control': cacheControl };
  if (notModified(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': contentType, 'content-length': stat.size });
  ctx.derivedStore.createVariantReadStream(source.contentHash, sig, ext).pipe(res);
}
