import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveConfig,
  parseFlags,
  openDatabase,
  createUser,
  ExtractionWorker,
  startServer,
  loadPluginRegistry,
  createEventBus,
  CONFIG_FILENAME,
} from '@archive/server';
import { createPrompter, isInteractive } from './prompt.js';

const USAGE = `archive — self-hosted, search-first file archive

Usage:
  archive init [--data-dir <path>] [--no-install]
  archive start [--port <n>] [--data-dir <path>]
  archive migrate [--data-dir <path>]
  archive create-user [--email <e>] [--name <n>] [--password <p>] [--data-dir <path>]
  archive plugins add <package> [--data-dir <path>]
  archive help

Options:
  --data-dir <path>   Where the SQLite db, blobs and config live (default: ~/.archive)
  --port <n>          HTTP port for \`start\` (default: 4321)
  --no-install        (init) scaffold config without running npm install

Environment:
  ARCHIVE_DATA_DIR, ARCHIVE_PORT (or PORT)
`;

// The CLI package a scaffolded project depends on (provides the `archive` bin).
const CLI_PKG = '@archive/cli';
// Plugins enabled in a freshly-initialized instance.
const DEFAULT_PLUGINS = ['@archive/plugin-text', '@archive/plugin-image'];

export async function runCli(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return cmdInit(rest);
    case 'start':
      return cmdStart(rest);
    case 'migrate':
      return cmdMigrate(rest);
    case 'create-user':
      return cmdCreateUser(rest);
    case 'plugins':
      return cmdPlugins(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

async function cmdMigrate(argv) {
  const { dataDir } = resolveConfig({ argv });
  openDatabase({ dataDir }).close();
  console.log(`Migrations up to date (${dataDir}).`);
}

// --- init ------------------------------------------------------------------

function pluginLocalName(pkg) {
  // '@archive/plugin-image' -> 'pluginImage'
  const base = pkg.split('/').pop();
  return base.replace(/[-_](\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '');
}

function renderConfig(plugins) {
  const imports = plugins.map((p) => `import ${pluginLocalName(p)} from '${p}';`).join('\n');
  const entries = plugins.map((p) => `    ${pluginLocalName(p)}(),`).join('\n');
  return `${imports}

// Archive instance config. Enable/disable plugins here, or add your own —
// any module exporting a plugin factory (local path or npm package) works.
export default {
  plugins: [
${entries}
  ],
};
`;
}

async function cmdInit(argv) {
  const flags = parseFlags(argv);
  // `init` scaffolds the current directory into an archive project by default
  // (the npx flow: `mkdir my-archive && cd my-archive && npx @archive/cli init`).
  const dataDir = path.resolve(flags['data-dir'] ?? process.env.ARCHIVE_DATA_DIR ?? '.');
  fs.mkdirSync(dataDir, { recursive: true });

  // Scaffold a runnable npm project: the CLI + plugins are local dependencies,
  // and `npm run start` / `npm run create-user` drive the local `archive` bin.
  const pkgPath = path.join(dataDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const dependencies = {
      [CLI_PKG]: '*',
      ...Object.fromEntries(DEFAULT_PLUGINS.map((p) => [p, '*'])),
    };
    fs.writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: path.basename(dataDir) || 'archive-instance',
          private: true,
          type: 'module',
          scripts: {
            start: 'archive start --data-dir .',
            'create-user': 'archive create-user --data-dir .',
          },
          dependencies,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`Wrote ${pkgPath}`);
  }

  const configPath = path.join(dataDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    console.log(`${CONFIG_FILENAME} already exists — leaving it untouched.`);
  } else {
    fs.writeFileSync(configPath, renderConfig(DEFAULT_PLUGINS));
    console.log(`Wrote ${configPath}`);
  }

  if (flags['no-install']) {
    console.log('Skipped npm install (--no-install); deps must be resolvable from the data dir.');
  } else {
    console.log('Installing the CLI + plugins …');
    const res = spawnSync('npm', ['install'], { cwd: dataDir, stdio: 'inherit' });
    if (res.status !== 0) throw new Error('npm install failed in the project directory');
  }

  console.log(`
Archive project ready in ${dataDir}

Next:
  npm run create-user -- --email you@example.com --password '<password>'
  npm run start                    # http://localhost:4321

(For an interactive password prompt, run the binary directly instead:
  ./node_modules/.bin/archive create-user --data-dir .)`);
}

// --- plugins ---------------------------------------------------------------

async function cmdPlugins(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'add') throw new Error(`Usage: archive plugins add <package>\n\n${USAGE}`);
  const flags = parseFlags(rest);
  const pkg = rest.find((a) => !a.startsWith('--'));
  if (!pkg) throw new Error('archive plugins add <package>: missing package name');
  const { dataDir } = resolveConfig({ argv: rest });

  if (!flags['no-install']) {
    const res = spawnSync('npm', ['install', pkg], { cwd: dataDir, stdio: 'inherit' });
    if (res.status !== 0) throw new Error(`npm install ${pkg} failed`);
  }
  addPluginToConfig(path.join(dataDir, CONFIG_FILENAME), pkg);
}

/** Best-effort insertion of a plugin import + factory call into the config. */
function addPluginToConfig(configPath, pkg) {
  if (!fs.existsSync(configPath)) throw new Error(`No ${CONFIG_FILENAME} — run \`archive init\` first`);
  const local = pluginLocalName(pkg);
  let src = fs.readFileSync(configPath, 'utf8');
  if (src.includes(`from '${pkg}'`)) {
    console.log(`${pkg} is already in the config.`);
    return;
  }
  const importLine = `import ${local} from '${pkg}';`;
  const lastImport = src.lastIndexOf('\nimport ');
  if (lastImport !== -1) {
    const eol = src.indexOf('\n', lastImport + 1);
    src = src.slice(0, eol + 1) + importLine + '\n' + src.slice(eol + 1);
  } else {
    src = importLine + '\n' + src;
  }
  // Insert into the plugins: [ ... ] array before its closing bracket.
  src = src.replace(/plugins:\s*\[/, (m) => `${m}\n    ${local}(),`);
  fs.writeFileSync(configPath, src);
  console.log(`Added ${pkg} to ${configPath}`);
}

// --- create-user -----------------------------------------------------------

/**
 * Resolve create-user inputs, prompting only when a required field is missing
 * AND we're interactive — so a fully-flagged invocation never prompts/hangs.
 * All guided prompts share one prompter (one readline interface). Exported for
 * testing; `makePrompter` is injectable.
 */
export async function resolveCreateUserInputs({
  flags,
  env = process.env,
  tty = isInteractive(),
  makePrompter = createPrompter,
}) {
  const havePassword = (flags.password ?? env.ARCHIVE_USER_PASSWORD) != null;
  const guided = tty && !(flags.email != null && havePassword);

  if (!guided) {
    return {
      email: flags.email ?? '',
      name: (flags.name ?? '') || null,
      password: flags.password ?? env.ARCHIVE_USER_PASSWORD ?? '',
    };
  }

  const p = makePrompter();
  try {
    const email = flags.email ?? (await p.ask('Email: '));
    const name = (flags.name ?? (await p.ask('Name (optional): '))) || null;
    const password =
      flags.password ?? env.ARCHIVE_USER_PASSWORD ?? (await p.askHidden('Password: '));
    return { email, name, password };
  } finally {
    p.close();
  }
}

async function cmdCreateUser(argv) {
  const { dataDir } = resolveConfig({ argv });
  const flags = parseFlags(argv);
  const { email, name, password } = await resolveCreateUserInputs({ flags });

  if (!email || !password) {
    throw new Error(
      'create-user needs an email and password. Pass --email and --password ' +
        '(or set ARCHIVE_USER_PASSWORD). Interactive prompts only work when the ' +
        'command is run directly in a terminal, not through `npm run`.'
    );
  }

  const db = openDatabase({ dataDir });
  try {
    const user = await createUser(db, { email, name, password });
    console.log(`Created user #${user.id}: ${user.email}`);
  } finally {
    db.close();
  }
}

// --- start -----------------------------------------------------------------

async function cmdStart(argv) {
  const { dataDir, port } = resolveConfig({ argv });

  // Load the instance's plugins from its config before touching the DB, so a
  // missing/broken config fails fast with a clear message.
  let registry;
  try {
    ({ registry } = await loadPluginRegistry(dataDir));
  } catch (err) {
    if (err.code === 'NO_CONFIG') throw new Error(err.message);
    throw new Error(`Failed to load ${CONFIG_FILENAME}: ${err.message}`);
  }

  const db = openDatabase({ dataDir }); // runs migrations

  // One event bus shared by the worker (emits on extraction) and the server's
  // SSE endpoint (forwards to browsers), so the UI updates without a refresh.
  const events = createEventBus();
  const worker = new ExtractionWorker(db, { dataDir, registry, events });
  worker.start();
  console.log(`Plugins: ${registry.plugins.map((p) => p.id).join(', ') || '(none)'}`);

  await startServer({
    db,
    port,
    dataDir,
    events,
    onVersionCreated: (versionId) => worker.enqueue(versionId),
  });
}
