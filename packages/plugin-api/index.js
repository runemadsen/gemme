/**
 * @gemme/plugin-api — the stable contract every Gemme plugin implements.
 *
 * Plugins depend on this tiny package (not on the server), so they don't couple
 * to core internals and can be versioned independently. The server checks a
 * plugin's `apiVersion` on load and rejects incompatible majors.
 *
 * A plugin module default-exports a *factory* so it can take options:
 *
 *   import { definePlugin } from '@gemme/plugin-api';
 *   export default function myPlugin(options = {}) {
 *     return definePlugin({
 *       id: 'my-plugin',
 *       matches(mimeType, filename) { return ... },
 *       async extract({ buffer, contentPath, mimeType, filename }) {
 *         return { metadata: [{ key, value, type }], fulltext };
 *       },
 *     });
 *   }
 *
 * ## Capabilities (all optional except matches/extract)
 *
 * A plugin declares *how its files behave*; the core stays format-agnostic and
 * simply asks "who handles this?". Beyond `id` / `matches` / `extract`, a plugin
 * may expose any of:
 *
 *   - `thumbnail = { contentType, async generate(source) -> Buffer|null }`
 *       The single pre-generated grid/detail image (worker-built, cached).
 *   - `preview(file, helpers) -> htmlString | null`
 *       The detail-page preview HTML. `helpers` = { escapeHtml, isPublic, url:{
 *       download, thumbnail, hls, publicOriginal, publicHls, publicSpec, asset } }.
 *       `url.asset(name)` maps to this plugin's own shipped `assets/`.
 *   - `renderer = { formats, thumbnail, normalize(params), run(source, spec) }`
 *       On-the-fly single-file transforms (e.g. the public image resize service).
 *   - `streamer = { spec, kind, entry, contentType(member), build(source, outDir) }`
 *       A pre-generated *bundle* of related files with an entry manifest (e.g.
 *       HLS: a master playlist + per-variant playlists + segments). `spec` is a
 *       serializable recipe that keys the bundle cache.
 *   - `assets` : absolute path to a directory of static files the plugin ships
 *       (player JS, hls.js, default images), served by the core at
 *       `/plugin-assets/<id>/*`. Set via
 *       `fileURLToPath(new URL('./assets/', import.meta.url))`.
 *
 * ## The `source` object
 *
 * `thumbnail.generate` / `renderer.run` / `streamer.build` receive a `source`:
 *   { contentHash, contentPath, mimeType, filename, loadBuffer() }
 * `contentPath` is the on-disk path (hand it to ffmpeg — never read a multi-GB
 * file into memory); `loadBuffer()` lazily returns the bytes for buffer-based
 * tools (e.g. sharp). `extract` still receives the eager `buffer` too.
 */

/** Current plugin API version. Bump the integer on a breaking contract change. */
export const apiVersion = 1;

/**
 * Validate and stamp a plugin definition with the API version it was built for.
 * @param {{id:string, matches:Function, extract:Function}} def
 * @returns {object} the plugin, with `apiVersion` attached
 */
export function definePlugin(def) {
  if (!def || typeof def !== 'object') throw new Error('definePlugin requires a definition object');
  if (!def.id || typeof def.id !== 'string') throw new Error('plugin requires a string `id`');
  if (typeof def.matches !== 'function') throw new Error(`plugin ${def.id}: matches() must be a function`);
  if (typeof def.extract !== 'function') throw new Error(`plugin ${def.id}: extract() must be a function`);
  return { apiVersion, ...def };
}
