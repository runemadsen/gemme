import { writeExtraction } from '../lib/metadata/store.js';
import { coreMetadata } from '../lib/metadata/core.js';
import { thumbnailFor, getThumbnail, makeSource, makeServingApi } from '../lib/serving.js';

/**
 * Extract metadata for a single file, then pre-generate its renditions.
 *
 * 1. Always records base "core" metadata, then runs every matching plugin's
 *    `extract` and merges the output (each plugin's failure is isolated).
 * 2. Pre-generates the file's derived **artifacts** from plugin capabilities: a
 *    single `thumbnail` (image resize / video frame / audio default), a
 *    `streamer` bundle (e.g. HLS for video), and any configured
 *    `renditions.pregenerate` image transforms. The thumbnail's content type is
 *    recorded on the file (`thumbnail_type`) and the bundle kind as
 *    `stream_type`, so the grid/detail decide cheaply without touching disk.
 *
 * Idempotent per file, so it is safe to re-run.
 *
 * @returns {{ok:boolean, thumbnail:boolean, stream:boolean, pluginErrors:Array<{plugin:string,message:string}>}}
 */
export async function runExtraction(db, ctx, fileId) {
  const { blobStore, registry } = ctx;

  const file = db
    .prepare(
      `SELECT id, content_hash, byte_size, mime_type, created_at,
              original_filename AS filename
         FROM files WHERE id = ?`
    )
    .get(fileId);
  if (!file) throw new Error(`File ${fileId} not found`);
  if (!blobStore.has(file.content_hash)) {
    throw new Error(`Blob ${file.content_hash} missing`);
  }

  const filename = file.filename;
  const mimeType = file.mime_type || 'application/octet-stream';
  // The lazy source given to plugins: `contentPath` for path-based tools
  // (ffmpeg/ffprobe) and `loadBuffer()` for byte-based ones (sharp, text) — so a
  // multi-GB video is never read into memory just to probe it.
  const source = makeSource(ctx, { contentHash: file.content_hash, mimeType, filename });

  // Base metadata that always exists — the "nothing is broken with just a file"
  // baseline. Also written at upload time (see indexFileCore); recomputed
  // here identically so a re-run stays consistent.
  const entries = coreMetadata({
    filename,
    mimeType,
    byteSize: file.byte_size,
    createdAt: file.created_at,
  });
  const fulltextParts = [];
  const pluginErrors = [];

  for (const plugin of registry.matching(mimeType, filename)) {
    try {
      const result =
        (await plugin.extract({
          mimeType,
          filename,
          contentPath: source.contentPath,
          loadBuffer: source.loadBuffer,
        })) || {};
      for (const m of result.metadata || []) {
        entries.push({ ...m, source: plugin.id });
      }
      if (result.fulltext) fulltextParts.push(result.fulltext);
    } catch (err) {
      pluginErrors.push({ plugin: plugin.id, message: err.message });
    }
  }

  const { thumbnailType, streamType } = await pregenerateArtifacts(ctx, file, mimeType, filename, pluginErrors);

  writeExtraction(db, {
    fileId,
    filename,
    entries,
    fulltext: fulltextParts.join('\n'),
    thumbnailType,
    streamType,
  });

  return { ok: true, thumbnail: Boolean(thumbnailType), stream: Boolean(streamType), pluginErrors };
}

/**
 * The single pre-generation phase: build a file's derived artifacts into the
 * derived store, entirely from plugin capabilities (the core stays
 * format-agnostic). Returns `{thumbnailType, streamType}` for the file row. Each
 * step isolates its own failure into `pluginErrors` and never fails extraction.
 */
async function pregenerateArtifacts(ctx, file, mimeType, filename, pluginErrors) {
  const { derivedStore, registry } = ctx;
  if (!derivedStore) return { thumbnailType: null, streamType: null }; // nowhere to persist
  const source = { contentHash: file.content_hash, mimeType, filename };
  let thumbnailType = null;
  let streamType = null;

  // 1. The single grid/detail thumbnail (plugin `thumbnail`: resize / frame /
  //    default image). It's a pre-generated artifact too — just with a dedicated
  //    capability + route rather than a served extension.
  const thumb = thumbnailFor(registry, mimeType, filename);
  if (thumb) {
    try {
      const out = await getThumbnail(ctx, source, thumb);
      if (out) thumbnailType = out.contentType;
    } catch (err) {
      pluginErrors.push({ plugin: 'thumbnail', message: `thumbnail failed: ${err.message}` });
    }
  }

  // 2. Expensive pre-generated serving artifacts (e.g. an HLS bundle) via the
  //    matching plugin's `serving.pregenerate`. Its return value (e.g. 'hls') is
  //    recorded as `stream_type`.
  const plugin = registry.matching(mimeType, filename).find((p) => p.serving?.pregenerate);
  if (plugin) {
    try {
      const api = makeServingApi(ctx, source, plugin);
      const tag = await plugin.serving.pregenerate({ source: api.source }, api);
      if (tag) streamType = tag;
    } catch (err) {
      pluginErrors.push({ plugin: plugin.id, message: `pregenerate failed: ${err.message}` });
    }
  }

  return { thumbnailType, streamType };
}

export { pregenerateArtifacts };
