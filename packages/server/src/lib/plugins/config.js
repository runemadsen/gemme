import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginRegistry } from './registry.js';

export const CONFIG_FILENAME = 'gemme.config.js';

/**
 * Load an instance's `gemme.config.js` and build a PluginRegistry from its
 * `plugins` array. The config is executable ESM living in the data dir; because
 * we import it by its own file URL, its `import`s for plugin packages resolve
 * against the data dir's node_modules (or, in the monorepo, the workspace
 * symlinks reachable from the data dir).
 *
 * @param {string} dataDir
 * @returns {Promise<{registry: PluginRegistry, config: object}>}
 * @throws {Error & {code:'NO_CONFIG'}} when no config file exists
 */
export async function loadPluginRegistry(dataDir) {
  const configPath = path.join(dataDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    const err = new Error(
      `No ${CONFIG_FILENAME} found in ${dataDir}. Run \`gemme init\` to create an instance.`
    );
    err.code = 'NO_CONFIG';
    throw err;
  }

  const mod = await import(pathToFileURL(configPath).href);
  const config = mod.default ?? {};
  const registry = new PluginRegistry();
  for (const plugin of config.plugins ?? []) {
    registry.register(plugin);
  }
  return { registry, config };
}
