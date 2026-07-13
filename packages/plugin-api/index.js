/**
 * @archive/plugin-api — the stable contract every Archive plugin implements.
 *
 * Plugins depend on this tiny package (not on the server), so they don't couple
 * to core internals and can be versioned independently. The server checks a
 * plugin's `apiVersion` on load and rejects incompatible majors.
 *
 * A plugin module default-exports a *factory* so it can take options:
 *
 *   import { definePlugin } from '@archive/plugin-api';
 *   export default function myPlugin(options = {}) {
 *     return definePlugin({
 *       id: 'my-plugin',
 *       matches(mimeType, filename) { return ... },
 *       async extract({ buffer, mimeType, filename }) {
 *         return { metadata: [{ key, value, type }], fulltext, thumbnail };
 *       },
 *     });
 *   }
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
