import { apiVersion as SUPPORTED_API } from '@gemme/plugin-api';

/**
 * Holds the set of metadata-extraction plugins for a running instance. Plugins
 * are supplied by the instance's config (see ./config.js) — the server no
 * longer bundles any. Multiple plugins may match one file; the worker runs all
 * matches and merges their output.
 */
export class PluginRegistry {
  constructor() {
    this.plugins = [];
  }

  register(plugin) {
    if (!plugin?.id || typeof plugin.matches !== 'function' || typeof plugin.extract !== 'function') {
      throw new Error('Invalid plugin: requires id, matches(), extract()');
    }
    // Reject plugins built against an incompatible API major.
    if (typeof plugin.apiVersion === 'number' && Math.trunc(plugin.apiVersion) !== Math.trunc(SUPPORTED_API)) {
      throw new Error(
        `Plugin "${plugin.id}" targets plugin-api v${plugin.apiVersion}, but this server supports v${SUPPORTED_API}`
      );
    }
    this.plugins.push(plugin);
    return this;
  }

  /** All plugins whose matches() returns true (throwing matches() are skipped). */
  matching(mimeType, filename) {
    return this.plugins.filter((p) => {
      try {
        return p.matches(mimeType, filename);
      } catch {
        return false;
      }
    });
  }
}
