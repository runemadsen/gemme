import { writeExtraction } from '../lib/metadata/store.js';
import { coreMetadata } from '../lib/metadata/core.js';

/** Default thumbnail spec handed to plugins. Kept consistent across filetypes. */
export const DEFAULT_THUMBNAIL_TARGET = { maxEdge: 512, format: 'webp' };

/**
 * Extract metadata for a single version: always records base "core" metadata,
 * then runs every matching plugin and merges their output. Each plugin's
 * failure is isolated — it's recorded but never blocks the others or the file.
 *
 * Plugins run in registry order and each receives `prior` — the metadata
 * accumulated so far plus whether a thumbnail has already been produced — so a
 * later plugin can skip work the first one already did (e.g. thumbnails: first
 * producer wins, the rest see `prior.thumbnail === true` and skip).
 *
 * If a thumbnail is produced and the context has a `derivedStore`, it is written
 * there (keyed by content hash) and the version's `thumbnail_type` is recorded.
 * Extraction is per-version and replaces prior results, so it is safe to re-run.
 *
 * @returns {{ok:boolean, thumbnail:boolean, pluginErrors:Array<{plugin:string,message:string}>}}
 */
export async function runExtraction(db, ctx, versionId) {
  const { blobStore, registry, derivedStore, thumbnailTarget = DEFAULT_THUMBNAIL_TARGET } = ctx;

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
  // Only offer a thumbnail target when we can actually persist the result.
  const target = derivedStore ? thumbnailTarget : null;
  let thumbnail = null;

  for (const plugin of registry.matching(mimeType, filename)) {
    try {
      const result =
        (await plugin.extract({
          buffer,
          mimeType,
          filename,
          thumbnailTarget: target,
          prior: { thumbnail: Boolean(thumbnail), metadata: entries.slice() },
        })) || {};
      for (const m of result.metadata || []) {
        entries.push({ ...m, source: plugin.id });
      }
      if (result.fulltext) fulltextParts.push(result.fulltext);
      // First plugin to return a valid thumbnail wins.
      if (!thumbnail && isThumbnail(result.thumbnail)) thumbnail = result.thumbnail;
    } catch (err) {
      pluginErrors.push({ plugin: plugin.id, message: err.message });
    }
  }

  if (thumbnail && derivedStore) {
    await derivedStore.putThumb(version.content_hash, thumbnail.contentType, thumbnail.data);
  }

  writeExtraction(db, {
    versionId,
    filename,
    entries,
    fulltext: fulltextParts.join('\n'),
    thumbnailType: thumbnail ? thumbnail.contentType : null,
  });

  return { ok: true, thumbnail: Boolean(thumbnail), pluginErrors };
}

function isThumbnail(t) {
  return t && Buffer.isBuffer(t.data) && typeof t.contentType === 'string' && t.data.length > 0;
}
