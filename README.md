# Gemme

A self-hosted, **search-first** archive for files of any type. Dump files in and
find them by searching name, date, and extracted metadata. It can also serve
files (e.g. as a central file server for website files).

Runs as a single process with just **Node.js + SQLite**. No external services,
minimal dependencies.

## Requirements

- Node.js **≥ 22.5**

## Quick start

An archive instance is just an npm project. Scaffold one with `npx`, which
installs the CLI locally, then run it with `npm run start`:

```bash
mkdir my-gemme && cd my-gemme
npx @gemme/cli init            # writes package.json + gemme.config.js, installs the CLI + plugins

npm run create-user -- --email you@example.com --password '<password>'
npm run start                    # http://localhost:4321
```

Then open http://localhost:4321, sign in, and drag files in. The project
directory holds everything: `package.json`, `gemme.config.js`, `gemme.db`, and
the content-addressed `blobs/`.

> The `gemme` binary comes from the locally-installed `@gemme/cli`, so the npm
> scripts (`start`, `create-user`) just work — no global install. For an
> interactive password prompt, run the local bin directly:
> `./node_modules/.bin/gemme create-user --data-dir .`

### CLI

Run via the project's npm scripts, `npx @gemme/cli <cmd>`, or the local
`./node_modules/.bin/gemme`:

| Command                                             | Description                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gemme init [--data-dir <path>] [--no-install]`     | Scaffold a project (package.json + config + plugins). Defaults to the current directory. |
| `gemme start [--port <n>] [--data-dir <path>]`      | Load plugins from config, run migrations, then serve.                                    |
| `gemme create-user [--email] [--name] [--password]` | Create a user.                                                                           |
| `gemme plugins add <package> [--data-dir <path>]`   | Install a plugin into the project and enable it.                                         |
| `gemme migrate [--data-dir <path>]`                 | Apply pending DB migrations.                                                             |

Config via flags or env: `GEMME_DATA_DIR`, `GEMME_PORT` (or `PORT`),
`GEMME_USER_PASSWORD`.

## Monorepo

The monorepo is built using NPM Workspaces.

| Package               | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `@gemme/plugin-api`   | The plugin contract (`definePlugin`, `apiVersion`).             |
| `@gemme/server`       | Core: storage, versioning, search, extraction worker, HTTP API. |
| `@gemme/cli`          | The `gemme` command.                                            |
| `@gemme/plugin-text`  | Full text + counts (zero-dep).                                  |
| `@gemme/plugin-image` | Image dimensions + EXIF.                                        |

Plugins live outside core: an instance's `gemme.config.js` imports and enables
them, so core ships no plugin dependencies and you can add your own plugin (a
local file or an npm package) just by importing it in the config.

## Development

First-time setup, then run:

```bash
npm install        # once: symlinks the workspace packages (and builds sharp)
npm run dev:init   # once: scaffold ./dev-instance (no per-instance install needed)
npm run dev:user   # once: create the dev login  →  dev@example.com / dev
npm run dev        # run the app at http://localhost:4321
```

Sign in with **dev@example.com / dev**. (Interactive prompting doesn't work
through `npm run` because it pipes stdout; `dev:user` uses fixed local
credentials instead. To create a real user with a prompt, run the CLI directly:
`node packages/cli/bin/gemme.js create-user --data-dir ./dev-instance`, or pass
`--email`/`--password`.)

After that, **`npm run dev`** is the everyday command. Other scripts:

```bash
npm test           # run every package's test suite
npm run gemme -- <cmd>   # run any CLI command against the repo, e.g.
                           #   npm run gemme -- plugins add @gemme/plugin-x --data-dir ./dev-instance
```

`./dev-instance` is a gitignored archive instance living inside the repo, so its
`gemme.config.js` resolves the `@gemme/plugin-*` packages through the workspace
symlinks — you can iterate on plugins with no publish/install step. Delete the
folder and re-run `dev:init` for a clean slate.

## How it works

- **Files & versions.** Each upload is a file with an ordered version
  history; the newest is current. Uploading again creates a _new file_ — adding
  a version is an explicit action. Bytes are content-addressed (SHA-256), so
  duplicates dedup.
- **Metadata.** A file is usable the instant it lands (just the filename). A
  background worker then runs extraction **plugins** and fills in metadata and
  full text. Multiple plugins can process one file and their output is merged.
  Default plugins: `text` (full text + counts, zero-dep) and `image`
  (dimensions, EXIF, and WebP thumbnails). PDF, video, AI tagging, etc. are
  opt-in plugins.
- **Search.** A single query box mixes full text and typed filters:

  ```
  mountains type:image width>1920 created>2024-01-01 -type:pdf
  ```

  Operators: `:` `=` `!=` `>` `<` `>=` `<=`. Values may carry units (`10s`,
  `1mb`). `-` negates any term.

The codebase is organized so the DB driver, upload wire format, and extraction
plugins are each isolated and replaceable. See `CLAUDE.md` for the architecture
and decision log.

## License

MIT
