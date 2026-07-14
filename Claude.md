# Gemme

This is a project to build a web-based application for people or organizations
who need to create an annotated archive of files (including images and text)
which can also be used as a a central file server for e.g. serving files for a
website.

This is a response to me always needing to copy/paste images across different
folders and repositories whenever I want to use them, and not having a central
place to store all of my work.

## Key princples

Here's a list of the key principles

- The archive should allow users to upload files of any type.
- Files are not stored locally in folders, but in a flat list, and you find your
  files in the interface by searching based on name, upload date, metadata, etc.
- All the information that the system needs is a file. So, users should be able
  to simply dump a bunch of files in and that's it. Later, they can add more
  metadata and organize in collections.
- Speed matters. Fast snappy interface with amazing search

Every file is private by default, but you can share them publically either from
a single file or from a collection of files.

The UI for adding (in bulk), tagging, and querying these files should be simple
and powerful.

## Decisions log

Decisions made while working through the concept. Keep this updated as we go.

### Files & versioning (decided)

- **File vs. version.** A file is a stable ID pointing at an ordered list of
  versions. Uploading again never overwrites bytes — it appends a new version.
- **Current = newest.** The current version is always the most recent upload. No
  rollback / pinning for now.
- **Retention.** Old versions are kept by default and only removed when
  explicitly deleted. Most files stay single-version (e.g. photos); some
  accumulate many (e.g. drafts).
- **New versions are explicit.** Dragging in files always creates *new files*.
  Adding a version is a deliberate "upload new version of this" action. Many
  files with the same filename may coexist — filename is a label, not identity.
- **Content-addressed storage.** Version bytes are stored under their content
  hash, so identical re-uploads dedup for free.
- **Upload dedup (skip identical).** `POST /api/files` skips creating a new
  file when a non-deleted file already has the **same filename AND same
  current-version content hash** (`findDuplicateFile`); it responds `200
  { file, skipped: true }` instead of `201`. Same name + different content, or
  different name + same content, still import. Since the client uploads one
  request per file, a bulk drop of N imports only the non-duplicates.
  Likewise, `POST /api/files/:id/versions` **skips** when the upload is
  byte-identical to the file's current version (also `200 { skipped: true }`),
  so re-adding the same bytes never creates a redundant version.

### Metadata (decided)

- **Extracted metadata lives on the version** — it is intrinsic to the bytes
  (EXIF, dimensions, PDF page count, extracted text). The file surfaces the
  current version's extracted metadata.
- **User metadata lives on the file** — it survives across versions and is
  never clobbered by a re-upload.
- **Extraction is plugin-based per filetype** and must be expandable. Core ships
  plugins (e.g. image/EXIF, PDF), and users can add more file plugins later.
- **Provenance.** Each file/version records which user performed the action.

### Users (decided)

- **Multiple users from day one.** No fine-grained permissions yet: every user
  can access everything. Files track the acting user for provenance.

### Sharing (decided)

- Files are **private by default**. Public share links point at the **current
  version only** — uploading a new version updates what every shared URL serves.

### Version history surfacing (decided)

- For now version history is **internal** (safety/audit), not independently
  browsable or downloadable in the UI. Door left open to expose it later.

### Tech stack (decided)

- **Runtime:** Node.js + built-in `node:sqlite` (zero native deps). Pin a minimum
  Node version. All DB access stays behind one module so we can swap to
  `better-sqlite3` if `node:sqlite` (experimental) bites us.
- **HTTP:** pure `node:http`, no web framework, with a small hand-written router.
  Multipart upload parsing is isolated behind one module (may use a focused dep
  like `busboy`, easily swapped).
- **Frontend:** pure vanilla Web Components, no framework, no build step. Server
  renders complete HTML; ~2 interactive "islands" (`<gemme-uploader>`,
  `<gemme-search>`) are native custom elements loaded as ES modules. The page is
  useful with zero JS — same "nothing is broken with just a file" philosophy.
- **API-first:** a JSON HTTP API holds all functionality; the frontend is a client
  of it. Everything runs in one process on one box.
- **Search:** the **filter DSL is the headline feature**. Storage/query layer is
  designed around typed filtering (`width=1080`, `duration>10s`) plus FTS5 full
  text. Extracted metadata stored as typed EAV (`version_metadata`) with a `source`
  column per plugin; keys are multi-valued.
- **Distribution:** `npx @gemme/cli init` scaffolds a project (no global
  install). Each instance is a small npm project whose `package.json` lists
  `@gemme/cli` + plugins as deps and has `start`/`create-user` scripts; you run
  it with `npm run start`. DB migrations run automatically on startup.

### Plugin interface (decided)

- A plugin exposes `id`, `matches(mimeType, filename)`, and
  `async extract(blobPath) -> { metadata: [{key, value, type}], fulltext?, thumbnail? }`.
- **Multiple plugins run per file** and their metadata is **merged** (each row
  tagged with the plugin `id`). E.g. an EXIF plugin and an object-recognition
  plugin both process one image. Per-plugin failure isolation: one crashing plugin
  never blocks ingestion or the others.
- Core ships an image plugin (EXIF/dimensions) and a PDF plugin (page count/text).
  External libs (image decode, PDF parse, thumbnailing, AI inference) stay behind
  the plugin boundary. Thumbnails are a derived artifact produced by a plugin.

### Deferred (not in v1)

- **Share links** — want to think through the best approach first.
- **Tags and custom fields** — later step.
- **rsync sync** of a local folder — later step.
- Markdown editor, output editors, mobile app — future.

## Architecture (v1)

Full design lives in the plan file referenced below; summary:

- **Storage:** single `--data-dir` holds `gemme.db`, content-addressed `blobs/`
  (sharded by hash prefix, dedup by SHA-256), and `derived/` thumbnails.
- **Data model:** `users`, `files` (→ current_version_id, soft delete),
  `versions` (content_hash, mime_type, extraction_status, thumbnail_type, and
  **version_no** — a per-file 1,2,3… number for display, distinct from the
  global `id`), `version_metadata` (typed EAV + source), `metadata_fts` (FTS5),
  `jobs` (durable queue), `schema_migrations`.
- **Background worker:** on upload the version's **core metadata (filename, ext,
  type, mime, size, created) + a filename FTS row are indexed synchronously**
  (`indexVersionCore`, inside the create transaction) so it's *searchable
  immediately* — before extraction. An in-process job runner then polls `jobs`
  and fills in plugin metadata (dimensions, EXIF, body text, thumbnail) later,
  running all matching plugins and merging output. Core is computed once in
  `metadata/core.js`, shared by upload-time indexing and extraction.
- **Search DSL:** parser → AST (free text vs `field op value`) → SQL compiler
  (FTS5 MATCH for text, typed EAV joins for filters).

### Upload wire format (decided during build)

Rather than pull in a multipart parser, uploads are **one file per request as a
raw body**: `POST /api/files` (new file) or `POST /api/files/:id/versions`
(new version) with the bytes as the request body, `X-Filename` (URL-encoded) and
`Content-Type` headers carrying the rest. Streams straight into the blob store.
Bulk upload = many parallel requests. Isolated in `src/server/upload.js` so it can
be swapped for multipart later. (We own both client and server, so no HTML-form
multipart is needed for v1.)

## Build order (v1 milestones, each TDD)

Tests use Node's built-in `node:test` + `assert` (zero deps); HTTP tested via
`fetch` against an ephemeral server on a temp data-dir. Run with `npm test`.

1. [DONE] Skeleton + storage core (CLI, config, DB module, migration runner, blob store).
2. [DONE] Users + auth (create-user, login/session, HTTP router + middleware).
3. [DONE] Files & versioning API (upload, add version, list, get, delete, download, provenance).
4. [DONE] Background worker + plugin system (multi-plugin merge, source tags, per-plugin
   failure isolation, re-runnable). Zero-dep core plugins: `text` (full text + counts)
   and `image` (dimensions via header parsing). EXIF/PDF/thumbnails/AI are future opt-in
   plugins that bring their own deps.
5. [DONE] Search / filter DSL (EAV + FTS5, parser, SQL compiler, `GET /api/search`).
6. [DONE] Frontend — server-rendered pages (login, file grid, file detail) served
   from `node:http`, plus two vanilla Web Component islands (`<gemme-uploader>`
   drag-drop upload with progress, `<gemme-search>` debounced DSL search) in
   `src/web/public/app.js`. No framework, no build step. Static files served from
   `/static/:file`. Files: `src/web/render.js`, `src/web/public/{app.js,styles.css}`,
   `src/server/routes/pages.js`.

**v1 complete.** All six milestones built TDD, then restructured into an npm-workspaces
monorepo with a config-driven plugin system (see below). 142 tests green (`npm test`). Verified
end-to-end against a live server: create-user → login → drag/upload → background
extraction → DSL search → versioning → download → detail pages.

Not covered by automated tests (needs a browser): in-page JS island behavior
(drag-drop, live-typing search). The module parses, its endpoints are tested, and
server-rendered pages are verified via HTTP.

### Search DSL grammar (as built — v1)

Query = whitespace-separated terms; any term negatable with leading `-`.
- **Field clause:** `key<op>value`, ops `:` `=` `!=` `>` `<` `>=` `<=`.
  `:` = contains (text) / equals (number/date); `=` = exact; `>`/`<`/… require a
  numeric or date value (else 400). Values may carry units: time `ms/s/min/h/d`,
  bytes `b/kb/mb/gb/tb` (normalized to a base number).
- **Value lists (OR within a field):** unquoted commas split a value into a list,
  e.g. `ext=jpg,png` or `type=image,video`. Quote to keep commas literal. This is
  what the filter sidebar emits; across fields clauses still AND.
- **Free text:** bare or `"quoted"` words → matched against FTS5 (filename tokens
  + extracted body) OR as a filename substring. Multiple terms AND; negatives exclude.
- Searches **current versions of non-deleted files**. Empty query = list all.
- Compiles to `EXISTS (… version_metadata …)` per clause + FTS subqueries.
  Files: `src/search/dsl.js` (parse/compile), `src/search/search.js` (execute).
  Examples: `mountains type:image width>1920 -type:pdf created>2024-01-01`.

Detailed plan: `~/.claude/plans/yes-the-metadata-extraction-synthetic-parasol.md`.

## Monorepo & plugin architecture (as built)

npm **workspaces** (no turborepo). One root `npm install` symlinks the packages.
**142 tests green** across the workspaces (`npm test`).

```
packages/
  plugin-api/    @gemme/plugin-api    tiny contract: definePlugin(), apiVersion
  server/        @gemme/server        core: db, storage, auth, files, search,
                                        worker, HTTP API, plugin loader
  cli/           @gemme/cli           the `gemme` bin (init/start/migrate/
                                        create-user/plugins add) → depends on server
  plugin-text/   @gemme/plugin-text   full text + counts (zero-dep)
  plugin-image/  @gemme/plugin-image  dimensions (header parse) + EXIF (exifr)
                                        + WebP thumbnails (sharp)
```

- **Plugins are packages, not bundled in core.** Each plugin default-exports a
  *factory* taking options, and depends only on `@gemme/plugin-api`. `server`
  ships zero plugin deps. `server` checks each plugin's `apiVersion` on load.
- **Each instance is a small npm project** (the npx flow: `mkdir my-gemme &&
  cd my-gemme && npx @gemme/cli init`). `init` defaults the data dir to the
  current directory and scaffolds `package.json` (deps: `@gemme/cli` + default
  plugins text/image; scripts: `start`, `create-user` → both `--data-dir .`),
  `gemme.config.js`, then runs `npm install` — so the `gemme` bin lands in
  local `node_modules/.bin`. You run it with `npm run start`. `gemme plugins add
  <pkg>` installs + edits the config. `gemme start` loads the config → builds
  the `PluginRegistry` → the worker uses it. Missing config → clear "run `gemme
  init`" error. (Interactive `create-user` prompts need a real TTY — through
  `npm run` you pass `--email`/`--password`; the both-TTY guard in
  `cli/src/prompt.js` prevents silently buffered prompts.)
- **Thumbnails.** Every file *can* have a thumbnail; none is fine (UI shows a
  gray rectangle — "just the file" still works). Thumbnails are **per-version**
  (they change with the bytes) and stored in a content-addressed **derived store**
  (`server/src/storage/derived.js`, `<dataDir>/derived/<hash>.thumb.<ext>`); the
  version records `thumbnail_type` (in the core schema, migration 001). Plugins run **in registry
  order** and each `extract()` receives `thumbnailTarget` ({maxEdge:512,
  format:'webp'}, core-provided) and `prior` (accumulated metadata + whether a
  thumbnail already exists). **First plugin to return one wins**; later plugins
  see `prior.thumbnail === true` and skip. Only `plugin-image` makes them today
  (via `sharp`, auto-oriented). Served at `GET /api/files/:id/thumbnail`
  (cache-busted per version); list/search expose `thumbnail_type`. Grid uses
  thumbnail-or-gray (no full-image fallback).
- **RAW images (`plugin-image`, done).** Camera RAW (`arw sr2 srf cr2 cr3 nef nrw
  raf orf rw2 dng pef srw 3fr iiq rwl mrw dcr kdc mos`) is supported without new
  deps. `matches` accepts RAW **by extension** (browsers send
  `application/octet-stream`). sharp can't decode RAW, so thumbnails always come
  from an **embedded JPEG preview**; there are two RAW families:
  - **TIFF-based** (ARW/NEF/CR2/DNG/ORF/RW2/…): exifr reads them straight from the
    buffer — dimensions from EXIF (`ExifImageWidth/Height`), fields via `EXIF_MAP`,
    thumbnail from `exifr.thumbnail(buffer)` (the small, ~160px IFD1 thumbnail).
  - **Fuji RAF** (and other non-TIFF containers): exifr throws "Unknown file
    format", so `rafPreview()` parses the `FUJIFILMCCD-RAW ` header (JPEG
    offset/length at 0x54/0x58, big-endian) to slice out the **full-size** embedded
    JPEG; exifr reads its EXIF/dimensions and sharp makes the thumbnail from it
    (so RAF thumbnails are high quality).
  Any failure degrades to metadata-only (no thumbnail), never blocks ingest. Known
  limits: TIFF-based previews are small/soft, EXIF dims are approximate — a real
  decoder (libraw/exiftool) is the deferred upgrade, behind the plugin boundary.
  Note: changing this code only affects **new** uploads; existing files must be
  re-extracted (re-run `runExtraction` per version) to pick it up.
- **Extension-first categorization.** `metadata/core.js` `categorize(mimeType,
  filename)` classifies by **extension** first (an `EXT_CATEGORY` map incl. RAW →
  `image`), falling back to MIME when the extension is unknown/absent — so a
  RAW upload is `type:image` in the facet/filter despite its generic MIME. The
  detail page (`render.js`) also decides the preview by extension: web-renderable
  images (`png jpg jpeg gif webp avif svg`) show the full `/download`; other
  images (RAW, heic, tiff) show the generated `/thumbnail` (raw bytes won't render
  in a browser); everything else has no preview. RAW ext list is duplicated in
  `plugin-image` `RAW_EXT` and core `EXT_CATEGORY` (separate packages) — keep in sync.
  - **Image cache policy (thumbnails + downloads).** The UI references
    **version-pinned** URLs for cached display — the grid thumbnail is
    `/api/files/:id/versions/:vid/thumbnail` and the detail photo is
    `/api/files/:id/versions/:vid/download` (both carry the current version id).
    These are served **`immutable`** (1-year, no revalidation) in production,
    because a version is written exactly once — created, extracted, thumbnailed —
    and **never regenerated**, so the version id fully identifies the bytes. When
    a new version becomes current the URL changes, so the cache busts naturally.
    The bare "latest" pointers (`/api/files/:id/thumbnail`, `.../download`) track
    a moving target and are therefore **always `no-cache` + strong `ETag`**
    (honoring `If-None-Match` → 304); they're for sharing/API, not cached display.
    The one thing that can break the immutable promise is **re-running extraction
    locally** (a plugin/`sharp` change rewrites a thumbnail for the same version),
    so **dev mode never sends `immutable`** — a `dev` config flag (`--dev` /
    `GEMME_DEV`, threaded to `ctx.dev`; the repo's `npm run dev` sets it) forces
    `no-cache` on the pinned routes too. This was the "grid shows the wrong
    thumbnail while the detail page is right, fixed by a hard refresh" bug: the old
    code marked thumbnails `immutable` and got poisoned by dev re-extraction.
    Files: `server/routes/files.js` (`cacheControl`, `pinned` flag),
    `lib/config.js` (`dev`), `server/index.js` (`ctx.dev`),
    `web/render.js` + `web/public/app.js` (version-pinned URLs);
    tests: `server/test/thumbnail.test.js`.
- **Config loader:** `server/src/plugins/config.js` `loadPluginRegistry(dataDir)`
  dynamic-imports `<dataDir>/gemme.config.js` by file URL, so its plugin imports
  resolve against the instance's own `node_modules`.
- **Collections (nestable, done):** unlimited-depth tree (`collections.parent_id`)
  with a **closure table** (`collection_closure`) so "all files in a collection
  incl. descendants" is one flat indexed query regardless of depth.
  `file_collections` is the many-to-many membership. **Filtering is by NAME**: the
  `collection` filter key (a `FILTER_KEY`, not an EAV facet) compiles to a
  closure+name `EXISTS` — so duplicate names union their subtrees, and selecting a
  name is descendant-inclusive. It rides the same query/URL/search-bar system
  (`collection=Trips,Docs`, `?collection=…`). CRUD API (`/api/collections`); the
  sidebar `<gemme-collections>` tree (multi-select by name →
  `store.filters.collection`), a `/collections` manager page, and membership
  checkboxes (by id) on the file detail page. Delete cascades the subtree (files
  untouched). Files: `collections/collections.js`,
  `server/routes/collections.js`, migration 004. Deferred: collection-based sharing.
- **Membership API is bulk (one collection × many files).**
  `POST` / `DELETE /api/collections/:id/files` with `{ fileIds }` add/remove a
  **set** of files to/from one collection in a single transaction, and work for
  one file via a one-element array — there is no per-file membership write
  endpoint. `GET /api/files/:id/collections` (single-file read) still backs the
  detail-page checkboxes. Data layer: `addFilesToCollection` /
  `removeFilesFromCollection` wrap the singular `addFileToCollection` /
  `removeFileFromCollection` in a transaction (singular kept for internal reuse).
  File **delete** is likewise bulk: `DELETE /api/files` with `{ fileIds }`
  (`softDeleteFiles`) — no `DELETE /api/files/:id`. All three validate a
  non-empty positive-int `fileIds` array (400 otherwise) and emit one `change`.
- **Add to collections from the Files grid (done):** `<gemme-files>` owns a
  **select mode** — a "Select" toggle turns cards into a multi-select (clicking a
  card toggles a corner check instead of navigating; `.selected` class on the
  `<a>`, so it survives keyed `reconcile`). The select bar picks one collection
  and **Add**s the whole selection via `POST /api/collections/:id/files`, then
  fires `gemme:changed` (sidebar counts + grid refresh). Selection is **cleared
  on query changes** (new result set) but **preserved across data refreshes**
  (extraction/SSE) — the two `refresh()` triggers are split for this;
  `applySelection()` re-marks surviving cards and forgets vanished ids.
  Add-only on the grid (removal stays on the detail page). Frontend-only beyond
  the shared bulk endpoint; `<gemme-files>` in `web/public/app.js`, styles under
  `/* --- grid multi-select --- */`.
- **Assign uploads to collections (done):** the upload page's `<gemme-uploader>`
  now renders a collection tree beneath the file list. After a drop, the just-
  uploaded files form a **batch** (their ids, including skipped duplicates so a
  re-dropped file can still be filed); ticking a collection files (or unfiles)
  the whole batch in **one** request via the bulk membership API
  (`POST/DELETE /api/collections/:id/files` with `{ fileIds }`, `setMembership`).
  Each new drop starts a **fresh round** (a bumped `round`
  counter; stale in-flight uploads bail on mismatch) that resets the file list,
  the batch, and the collection selection — so uploading over many rounds always
  assigns to just the most recent batch. The tree is hidden until ≥1 file lands.
  Frontend-only (no server change); `<gemme-uploader>` in `web/public/app.js`.
- **Filters (faceted, extensible):** `GET /api/facets?keys=ext,type` returns, per
  metadata key, the distinct text values in the archive with counts (a GROUP BY
  over the EAV table — works for ANY key with no per-filter backend code). The
  `<gemme-filters>` sidebar renders a section per facet (config `FACETS` in
  `web/public/app.js` — add a key to add a filter) and broadcasts selected values
  as `gemme:filters`. `<gemme-files>` composes `search text + filters` into
  one DSL query (filters become `key=v1,v2`), so filtering reuses the whole search
  + live-reconcile pipeline. Facet counts are whole-archive (not query-scoped) for
  now. Files: `facets/facets.js`, `server/routes/facets.js`.
- **Unified search + filter state (one source of truth):** state is
  `{ text, filters }`. The search bar, the filter sidebar, the URL, and the grid
  are all *views* of it. A client-side `store` (in `web/public/app.js`) owns it;
  the search bar (searches **on Enter only**) and sidebar checkboxes are the two
  editors. Typing a facet command (`ext:jpg`, `ext=jpg,png`) is parsed out into
  `filters`, so it's equivalent to clicking the sidebar — both normalize to the
  same canonical query and the same URL. Toggling a filter re-populates the search
  bar; both stay in sync. `search/compose.js` is the server source of truth
  (`resolveState` folds facet commands out of `q` too, `parseQueryString`,
  `composeQuery`, `stateToUrl`, `FACET_KEYS`), mirrored in `app.js`.
- **Sorting + pagination:** the state also carries `sort` (`date`|`name`),
  `direction` (`asc`|`desc`), `page`, `perPage` — reserved URL params (not facet
  keys), normalized/whitelisted in `compose.js`. `searchFiles` takes
  `sort`/`direction` (whitelisted → SQL column, no injection); `paginatedSearch`
  slices by page and clamps an out-of-range page to the last. `GET /api/search`
  returns `{ items, total, page, perPage, pages, sort, direction }`; `GET /`
  renders the first page sorted, with server-rendered controls + pager. Frontend:
  `<gemme-controls>` (sort/order/per-page selects) and `<gemme-pager>`
  (numbered links + Prev/Next); changing search/filters/sort/perPage resets to
  page 1, page nav keeps everything else. All flow through the store → grid
  reconciles in place, no reload.
- **Shareable filter URLs:** the state serializes to `?q=<text>` + one repeated
  param per facet key (`?q=trip&ext=jpg&ext=png&type=image`). `GET /` renders the
  grid **server-side filtered** (correct on first paint, works before JS); the
  client hydrates bar + checkboxes and rewrites the URL (`history.replaceState`)
  on every change. `?q=ext:jpg` and `?ext=jpg` resolve identically. Paste a URL →
  same filtered view.
- **Live updates (no refresh):** the file grid is a pure function of
  `query -> items`. The client (`<gemme-files>`) re-runs its current query and
  **reconciles cards by file id** (updating only those whose signature —
  thumbnail/version/status/size/name — changed, so unchanged thumbnails don't
  reload). Two triggers funnel into one `refresh()`: query changes
  (`<gemme-search>` → `gemme:query`) and data changes pushed over **SSE**
  (`GET /api/events`, plain `text/event-stream` on node:http). Write routes and
  the extraction worker emit `change` on a shared in-process bus
  (`events/bus.js`); the SSE route forwards to browsers; the client coalesces
  bursts. So a `pending` card gains its thumbnail the moment extraction finishes.
- **Local dev needs no per-instance install:** `npm run dev:init` creates
  `./dev-instance` (inside the repo) with `--no-install`; its config imports the
  `@gemme/plugin-*` packages by name, which resolve through the workspace
  symlinks in the repo's root `node_modules`. `npm run dev` starts it. Verified:
  the app loads real plugins and extracts metadata with no `node_modules` in the
  instance.

### Source map (within packages/server/src, unless noted)

**Util/domain modules live under `src/lib/`.** Outside `lib`: `src/server` (HTTP),
`src/web` (frontend), `src/worker` (background extraction — core, not a util), and
`src/index.js` (package entry). Single-file modules go directly in `lib/` (e.g.
`lib/files.js`); multi-file modules keep a folder (e.g. `lib/auth/`).

- `packages/cli/{bin/gemme.js, src/cli.js, src/prompt.js}` — CLI.
- `index.js` — package entry: re-exports the public API from `lib/*` + `server/`.
- `lib/config.js` — flag/env/default config resolution (+ `parseFlags`).
- `lib/db/` — `index.js` (single `node:sqlite` access point), `migrate.js` (applies
  `migrations/*.sql` in filename order, tracked in `schema_migrations`), `migrations/*.sql`.
  Migrations are a **consolidated baseline** (001 core → 002 sessions → 003 metadata+jobs
  → 004 collections): since nothing is deployed yet, early `ALTER TABLE`s were folded back
  into the original `CREATE TABLE`s for a clean starting point. Add new schema changes as
  new numbered migrations from here — don't rewrite the baseline once there's real data.
- `lib/storage/` — `blobs.js` (content-addressed, SHA-256), `derived.js` (thumbnails).
- `lib/auth/` — `passwords.js` (scrypt), `users.js`, `sessions.js`.
- `lib/files.js` — file/version data layer + versioning rules.
- `lib/collections.js` — collection tree + closure maintenance + membership.
- `lib/facets.js` — distinct-value + count aggregation per metadata key.
- `lib/bus.js` — in-process `change` pub/sub shared by routes + worker + SSE.
- `lib/metadata/` — `core.js` (shared core-metadata), `store.js` (typed EAV + FTS;
  `indexVersionCore` for upload-time indexing).
- `lib/search/` — `dsl.js` (parse/compile), `compose.js` (state⇄string⇄URL),
  `search.js` (`searchFiles`, `paginatedSearch`).
- `lib/plugins/` — `registry.js` (`PluginRegistry` + apiVersion check), `config.js` (loader).
- `worker/` — `extract.js` (core + plugin merge, thumbnails), `queue.js`, `index.js`
  (`ExtractionWorker`, `runPending`; emits `change`; requires an explicit registry).
  Top-level (not a util); imports its deps from `../lib/…`.
- `server/` — `index.js` (createApp), `router.js`, `respond.js`, `middleware.js`,
  `upload.js`, `routes/{auth,files,search,pages,events,facets,collections}.js`.
- `web/` — `render.js` + `public/{app.js,styles.css}`; `<gemme-files>` does
  keyed reconciliation + SSE, `<gemme-search>` emits query events.
- Tests live in each package's `test/`; `server/test/helpers/` boots an ephemeral
  app and provides a `fakeRegistry()` so server tests don't depend on the real
  plugin packages (those are tested in their own packages).

### Not yet done / known gaps

- `@gemme/*` packages are **not published to npm** yet, so `gemme init` with a
  real install only works once published; today the working path is the in-repo
  dev instance (workspace symlinks). Publishing is a future step.
- Thumbnails exist for **images** (plugin-image via sharp). Video/PDF/etc.
  thumbnails are future plugins — they just need to return a `thumbnail` from
  `extract()`; the derived-store + serving machinery already handles them.

## Use cases

Here's a few examples of users who would want to use this application:

- I am an avid photographer and want to store all of my photos in an archive. I
  want to be able to easily find images through search and share collections of
  these photos why my friends and family.
- I am a professor and want to store all of my research, including PDF files,
  links and references in an archive. I want to be able to easily filter this
  research and share filtered lists to my collaborators. or the public.
- I am a writer and wants to archive all of my writing.

ALSO WORKS ON MARKDOWN FILES!! THERE CAN BE AN EDITOR AND IT CAN REFER TO IMAGES
IN THE ARCHIVE!!!

## Technical principles

- The application should run on a single instance using only JavaScript and
  SQLite. My dream is to just buy a Hertzner instance and run it all on that.
- We should rely on as few external dependencies as possible. We shouldn't
  implement complex stuff such as image resizing, but let's keep the stuff
  relying on external packages isolated and easy to replace.
- Everything should be test driven.
- When I run the app and need to upgrade, it should be possible to upgrade
  entirely through NPM. Any DB migrations and such should be done in post
  installcd

Make CSS spec Make UI spec Use shared components

Support all file types with plugins per file type that says how to handle it Can
be extended with open source file plugins Metadata extractors based on filetypes
(image metadata, object recognition, PDF summary, etc).

## Future plans

It could have output editors, allowing people to write documents or slideshows
using the images. These outputs should be built into the software.

It should be easy to upload files from your phone or computer. We could
eventually make a mobile app that just syncs all pictures to the archive.

## Agent instructions

Update Claude.md as you go along including with the architecture, requirements
and this instruction to keep updating Claude.md Always present decisions with
pros and cons
