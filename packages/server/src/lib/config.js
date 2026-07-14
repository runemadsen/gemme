import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4321;

/**
 * Resolve runtime configuration from CLI flags and environment.
 *
 * Precedence: explicit flags > environment > built-in defaults.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - argv slice after the command (e.g. ["--port", "8080"])
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ dataDir: string, port: number }}
 */
export function resolveConfig({ argv = [], env = process.env } = {}) {
  const flags = parseFlags(argv);

  const dataDir = path.resolve(
    flags['data-dir'] ?? env.GEMME_DATA_DIR ?? path.join(os.homedir(), '.gemme')
  );

  const rawPort = flags.port ?? env.GEMME_PORT ?? env.PORT;
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  // Dev mode disables long-lived file caching (see the image cache policy in
  // routes/files.js): re-running extraction locally must never poison the
  // browser cache. Off by default — real instances run in production mode.
  const dev = flags.dev === true || flags.dev === 'true' || env.GEMME_DEV === '1' || env.GEMME_DEV === 'true';

  return { dataDir, port, dev };
}

/**
 * Minimal `--key value` / `--key=value` / `--flag` parser.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[++i];
    } else {
      flags[body] = true;
    }
  }
  return flags;
}
