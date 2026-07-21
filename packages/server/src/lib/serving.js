import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import { extForType } from './storage/derived.js';

/**
 * Unified serving engine. The core is format-agnostic: a plugin declares which
 * output extensions it serves (`serving.formats`) and one `serve` callback; the
 * core dispatches by extension and streams whatever the callback returns.
 *
 * Plugins never touch the filesystem, cache keys, or HTTP — they only call the
 * `api` built here and return a **descriptor** shaped for `streamBytes`
 * (`{ size, contentType, etag, open(range) }`). This module owns the derived
 * store (single-file variants + directory bundles), cache signatures, and the
 * thumbnail capability. It absorbs the old renditions.js + bundles.js.
 */

/**
 * The lazy `source` handed to serving/thumbnail/extract capabilities:
 * `contentPath` for path-based tools (ffmpeg), `loadBuffer()` for byte-based
 * ones (sharp) — so a multi-GB video is never read into memory to probe it.
 */
export function makeSource(ctx, { contentHash, mimeType, filename }) {
  let cached;
  return {
    contentHash,
    contentPath: ctx.blobStore.pathForHash(contentHash),
    mimeType,
    filename,
    loadBuffer: async () => (cached ??= await ctx.blobStore.readBuffer(contentHash)),
  };
}

/** Short, stable cache signature for a canonical key + output extension. */
export function specSig(key, ext) {
  return crypto.createHash('sha256').update(`${JSON.stringify(key)}|${ext}`).digest('hex').slice(0, 16);
}

/** First matching plugin that serves `ext` via its `serving` capability, or null. */
export function servingFor(registry, mimeType, filename, ext) {
  for (const plugin of registry?.matching?.(mimeType, filename) ?? []) {
    if (plugin.serving?.formats?.includes(ext)) return plugin;
  }
  return null;
}

/** Per-file bundle cache signature (namespaced by plugin id + serving.version). */
function bundleSig(plugin) {
  return specSig({ p: plugin.id, v: plugin.serving?.version ?? 1 }, 'bundle');
}

/**
 * Build the serving `api` handed to a plugin's `serve`/`pregenerate`. All
 * storage, cache keys, and streaming live here; the plugin only calls these and
 * returns the descriptor they produce. `api.source` is the lazy source
 * (`contentPath` + `loadBuffer()`) — the plugin should read from that.
 *
 * @param {{blobStore, derivedStore}} ctx
 * @param {{contentHash, mimeType?, filename?}} rawSource
 * @param {object} plugin
 */
export function makeServingApi(ctx, rawSource, plugin) {
  const { derivedStore } = ctx;
  const source = makeSource(ctx, rawSource);
  return {
    source,

    /**
     * Ensure a cached single derived file, generating it on a miss. For
     * on-the-fly transforms (image variants). `produce` returns a Buffer (or
     * null → the descriptor is null → 404). Returns a streamBytes descriptor.
     */
    async rendition(cacheKey, ext, contentType, produce) {
      const sig = specSig(cacheKey, ext);
      if (!derivedStore.hasVariant(source.contentHash, sig, ext)) {
        const data = await produce();
        if (!data) return null;
        await derivedStore.putVariant(source.contentHash, sig, ext, data);
      }
      const stat = derivedStore.statVariant(source.contentHash, sig, ext);
      return {
        size: stat.size,
        contentType,
        etag: `"${source.contentHash}-${sig}"`,
        open: (range) => derivedStore.createVariantReadStream(source.contentHash, sig, ext, range),
      };
    },

    /** A member of this file's pre-generated bundle; null if absent (→ 404). */
    member(memberPath, contentType) {
      const sig = bundleSig(plugin);
      if (!derivedStore.hasMember(source.contentHash, sig, memberPath)) return null;
      const stat = derivedStore.statMember(source.contentHash, sig, memberPath);
      return {
        size: stat.size,
        contentType,
        etag: `"${source.contentHash}-${sig}-${memberPath}"`,
        open: (range) => derivedStore.createMemberReadStream(source.contentHash, sig, memberPath, range),
      };
    },

    /** Inline bytes (small/dynamic responses). Range-safe (slices the buffer). */
    bytes(buffer, contentType) {
      const sig = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      return {
        size: buffer.length,
        contentType,
        etag: `"${source.contentHash}-${sig}"`,
        open: (range) => Readable.from(range ? buffer.subarray(range.start, range.end + 1) : buffer),
      };
    },

    /**
     * pregenerate only: build a bundle into a temp dir and publish it atomically
     * under this file's bundle key. Idempotent (no-op if already present); a
     * failed build discards the temp dir and never publishes a partial bundle.
     */
    async buildBundle(builder) {
      const sig = bundleSig(plugin);
      if (derivedStore.hasBundle(source.contentHash, sig)) return;
      const tmpDir = await derivedStore.makeTempDir();
      try {
        await builder(tmpDir);
      } catch (err) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        throw err;
      }
      await derivedStore.putBundle(source.contentHash, sig, tmpDir);
    },
  };
}

// A file has at most one thumbnail; store it under a fixed sig so serving can
// locate it from `thumbnail_type` alone.
const THUMB_SIG = 'thumb';

/** First matching plugin that exposes a `thumbnail` capability, or null. */
export function thumbnailFor(registry, mimeType, filename) {
  return registry?.capability?.(mimeType, filename, 'thumbnail') ?? null;
}

/**
 * Generate-or-fetch a file's single pre-generated thumbnail via a plugin's
 * `thumbnail` capability (`{ contentType, async generate(source) -> Buffer|null }`).
 * Returns `{sig, ext, contentType}` or null when the plugin declines/can't.
 */
export async function getThumbnail(ctx, source, thumb) {
  const ext = extForType(thumb.contentType);
  const { derivedStore } = ctx;
  if (!derivedStore.hasVariant(source.contentHash, THUMB_SIG, ext)) {
    const out = await thumb.generate(makeSource(ctx, source));
    const data = Buffer.isBuffer(out) ? out : out?.data;
    if (!data) return null;
    await derivedStore.putVariant(source.contentHash, THUMB_SIG, ext, data);
  }
  return { sig: THUMB_SIG, ext, contentType: thumb.contentType };
}
