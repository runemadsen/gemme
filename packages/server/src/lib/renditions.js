import crypto from 'node:crypto';
import { HttpError } from '../server/respond.js';

/**
 * Rendition engine. A "rendition" is a derived image produced from a source
 * version by a plugin's `renderer` capability. Thumbnails (a pre-generated
 * preset) and public on-the-fly transforms are the same mechanism.
 *
 * The core owns everything cross-cutting — picking a renderer, the canonical
 * cache key, the content-addressed variant cache, and content types. Plugins
 * only contribute `formats`, a `thumbnail` preset, `normalize(params)` (cheap,
 * deterministic → the cache key, so we can check the cache before rendering),
 * and `run(source, spec)` (the actual bytes).
 */

const EXT_CONTENT_TYPE = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
};

export function contentTypeForExt(ext) {
  return EXT_CONTENT_TYPE[ext] || null;
}

/** First matching plugin that exposes a renderer, or null. */
export function rendererFor(registry, mimeType, filename) {
  for (const plugin of registry?.matching?.(mimeType, filename) ?? []) {
    if (plugin.renderer) return plugin.renderer;
  }
  return null;
}

/**
 * Parse a spec segment like `w=800,fit=cover.webp` → { params, ext }.
 * The output format is the extension; params are comma-separated `key=value`
 * (tokens without `=` are ignored, so `photo.webp` is a pretty reformat-only URL).
 * Returns null if there's no extension.
 */
export function parseSpecSegment(seg) {
  const dot = seg.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = seg.slice(dot + 1).toLowerCase();
  const params = {};
  for (const tok of seg.slice(0, dot).split(',')) {
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    params[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return { params, ext };
}

/** Short, stable cache signature for a canonical spec + output extension. */
export function specSig(spec, ext) {
  return crypto.createHash('sha256').update(`${JSON.stringify(spec)}|${ext}`).digest('hex').slice(0, 16);
}

/**
 * A renderer's `thumbnail` preset (e.g. `{width:512, format:'webp'}`) → the
 * `{spec, ext}` the engine uses. Run through `normalize` so the thumbnail shares
 * a cache key with the equivalent URL request (`/i/:id/w=512.webp` → same file).
 */
export function thumbnailSpec(renderer) {
  const { format, ...rest } = renderer.thumbnail;
  return { spec: renderer.normalize(canonicalToParams(rest)), ext: format };
}

/** A config spec string like `w=1024.webp` → `{spec, ext}` for `renderer`. */
export function specFromString(renderer, str) {
  const parsed = parseSpecSegment(str);
  if (!parsed) throw new Error(`invalid rendition spec: ${str}`);
  return { spec: renderer.normalize(parsed.params), ext: parsed.ext };
}

/** Canonical spec object → the raw string params `normalize` expects. */
function canonicalToParams(spec) {
  const map = {};
  if (spec.width != null) map.w = String(spec.width);
  if (spec.height != null) map.h = String(spec.height);
  if (spec.fit != null) map.fit = spec.fit;
  if (spec.quality != null) map.q = String(spec.quality);
  return map;
}

/**
 * Produce (or fetch from the variant cache) a rendition of a source version.
 *
 * @param {{blobStore, derivedStore}} ctx
 * @param {{contentHash:string, mimeType?:string, filename?:string}} source
 * @param {object} renderer - the plugin renderer
 * @param {object} spec - canonical spec from `renderer.normalize`
 * @param {string} ext - output extension (must be in `renderer.formats`)
 * @returns {Promise<{sig:string, ext:string, contentType:string}>}
 */
export async function getRendition(ctx, source, renderer, spec, ext) {
  const { blobStore, derivedStore } = ctx;
  const sig = specSig(spec, ext);
  if (!derivedStore.hasVariant(source.contentHash, sig, ext)) {
    const buffer = await blobStore.readBuffer(source.contentHash);
    const out = await renderer.run(
      { buffer, mimeType: source.mimeType, filename: source.filename },
      { ...spec, format: ext }
    );
    if (!out) throw new HttpError(415, 'Cannot render this file');
    await derivedStore.putVariant(source.contentHash, sig, ext, out.data);
  }
  return { sig, ext, contentType: contentTypeForExt(ext) };
}
