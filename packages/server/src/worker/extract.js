import { writeExtraction } from '../lib/metadata/store.js';
import { coreMetadata } from '../lib/metadata/core.js';
import { rendererFor, getRendition, thumbnailSpec, specFromString } from '../lib/renditions.js';

/**
 * Extract metadata for a single version, then pre-generate its renditions.
 *
 * 1. Always records base "core" metadata, then runs every matching plugin's
 *    `extract` and merges the output (each plugin's failure is isolated).
 * 2. Pre-generates renditions via the file's renderer (if any): the renderer's
 *    `thumbnail` preset plus any configured `renditions.pregenerate` specs. The
 *    thumbnail's content type is recorded on the version (`thumbnail_type`) so
 *    the grid can render cheaply. Thumbnails are ordinary renditions — served
 *    and cached exactly like public on-the-fly transforms.
 *
 * Idempotent per version, so it is safe to re-run.
 *
 * @returns {{ok:boolean, thumbnail:boolean, pluginErrors:Array<{plugin:string,message:string}>}}
 */
export async function runExtraction(db, ctx, versionId) {
  const { blobStore, registry } = ctx;

  const version = db
    .prepare(
      `SELECT v.id, v.content_hash, v.byte_size, v.mime_type, v.created_at,
              a.original_filename AS filename
         FROM versions v JOIN files a ON a.id = v.file_id
        WHERE v.id = ?`
    )
    .get(versionId);
  if (!version) throw new Error(`Version ${versionId} not found`);
  if (!blobStore.has(version.content_hash)) {
    throw new Error(`Blob ${version.content_hash} missing`);
  }

  const buffer = await blobStore.readBuffer(version.content_hash);
  const filename = version.filename;
  const mimeType = version.mime_type || 'application/octet-stream';

  // Base metadata that always exists — the "nothing is broken with just a file"
  // baseline. Also written at upload time (see indexVersionCore); recomputed
  // here identically so a re-run stays consistent.
  const entries = coreMetadata({
    filename,
    mimeType,
    byteSize: version.byte_size,
    createdAt: version.created_at,
  });
  const fulltextParts = [];
  const pluginErrors = [];

  for (const plugin of registry.matching(mimeType, filename)) {
    try {
      const result = (await plugin.extract({ buffer, mimeType, filename })) || {};
      for (const m of result.metadata || []) {
        entries.push({ ...m, source: plugin.id });
      }
      if (result.fulltext) fulltextParts.push(result.fulltext);
    } catch (err) {
      pluginErrors.push({ plugin: plugin.id, message: err.message });
    }
  }

  const thumbnailType = await pregenerateRenditions(ctx, version, mimeType, filename, pluginErrors);

  writeExtraction(db, {
    versionId,
    filename,
    entries,
    fulltext: fulltextParts.join('\n'),
    thumbnailType,
  });

  return { ok: true, thumbnail: Boolean(thumbnailType), pluginErrors };
}

/**
 * Pre-generate the thumbnail preset + any configured extra renditions into the
 * derived store. Returns the thumbnail rendition's content type (for
 * `thumbnail_type`), or null when there's no renderer / it can't render.
 * Per-rendition failures are recorded but never fail extraction.
 */
async function pregenerateRenditions(ctx, version, mimeType, filename, pluginErrors) {
  const { derivedStore, registry, renditions } = ctx;
  if (!derivedStore) return null; // nowhere to persist
  const renderer = rendererFor(registry, mimeType, filename);
  if (!renderer) return null;

  const source = { contentHash: version.content_hash, mimeType, filename };
  let thumbnailType = null;

  // The thumbnail preset first (so its content type is known), then config extras.
  const jobs = [{ ...thumbnailSpec(renderer), isThumb: true }];
  for (const str of renditions?.pregenerate ?? []) {
    try {
      jobs.push({ ...specFromString(renderer, str), isThumb: false });
    } catch (err) {
      pluginErrors.push({ plugin: 'renderer', message: `bad rendition spec: ${err.message}` });
    }
  }

  for (const job of jobs) {
    try {
      if (!renderer.formats.includes(job.ext)) throw new Error(`unsupported output format: ${job.ext}`);
      const out = await getRendition(ctx, source, renderer, job.spec, job.ext);
      if (job.isThumb) thumbnailType = out.contentType;
    } catch (err) {
      pluginErrors.push({ plugin: 'renderer', message: `pregenerate failed: ${err.message}` });
    }
  }
  return thumbnailType;
}

export { pregenerateRenditions };
