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

### Files (decided — no versions)

- **A file IS one immutable blob.** A file is a stable ID with a single set of
  bytes (`content_hash`) that never change for its lifetime. There is **no
  version history** — we removed it deliberately (see "Removing versions" below).
- **"A new version" = a new file.** Re-uploading the same content under a
  different intent just creates another file. Many files with the same filename
  may coexist — filename is a label, not identity.
- **Content-addressed storage.** File bytes are stored under their content hash,
  so identical re-uploads dedup the blob on disk for free.
- **Upload dedup (skip identical).** `POST /api/files` skips creating a new file
  when a non-deleted file already has the **same filename AND same content hash**
  (`findDuplicateFile`); it responds `200 { file, skipped: true }` instead of
  `201`. Same name + different content, or different name + same content, still
  import. Since the client uploads one request per file, a bulk drop of N imports
  only the non-duplicates.

### Removing versions (decided)

- **Why.** Versioning made caching hard: to serve images `immutable` we needed
  *version-pinned* URLs (`/api/files/:id/versions/:vid/…`) while the bare by-id
  URLs tracked a moving "current" pointer and had to be `no-cache`. Collapsing to
  one-blob-per-file means a file id fully identifies its bytes, so **every serving
  URL is safely `immutable`** and the whole pinned/bare duality disappears.
- **What changed.** The `versions` table, `files.current_version_id`, and
  `version_no` are gone; the blob columns (`content_hash`, `byte_size`,
  `mime_type`, `extraction_status`, `thumbnail_type`) live directly on `files`.
  Metadata/FTS/jobs are keyed by `file_id` (`file_metadata`, `metadata_fts.file_id`,
  `jobs.file_id`). The add-version / delete-version routes and the detail-page
  "Versions" section were removed. Identifiers were renamed file-based
  (`createFile`, `indexFileCore`, `getFileMetadata`, `onFileCreated`).
- The app was **not deployed**, so the baseline migrations were edited in place
  rather than adding a data-migration.

### Metadata (decided)

- **Extracted metadata lives on the file** — it is intrinsic to the bytes (EXIF,
  dimensions, PDF page count, extracted text), stored in `file_metadata`.
- **Extraction is plugin-based per filetype** and must be expandable. Core ships
  plugins (e.g. image/EXIF, PDF), and users can add more file plugins later.
- **Provenance.** Each file records which user uploaded it.

### Users (decided)

- **Multiple users from day one.** No fine-grained permissions yet: every user
  can access everything. Files track the acting user for provenance.

### Sharing (decided)

- Files are **private by default**. A public file is served at a stable by-id URL
  (`/i/:id`); since a file's bytes never change, that URL always serves the same
  content.

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
  text. Extracted metadata stored as typed EAV (`file_metadata`) with a `source`
  column per plugin; keys are multi-valued.
- **Distribution:** `npx @gemme/cli init` scaffolds a project (no global
  install). Each instance is a small npm project whose `package.json` lists
  `@gemme/cli` + plugins as deps and has `start`/`create-user` scripts; you run
  it with `npm run start`. DB migrations run automatically on startup.

### Plugin interface (decided — format-agnostic core)

The guiding principle: **a strong, simple core + flexible plugins.** A plugin
declares *how its files behave*; the core owns only generic machinery (routing,
auth/visibility, caching, HTTP Range, the derived cache) and asks "which plugin
handles this?" — it never branches on file type. Adding a new format = a new
plugin, **no core change**. Capability lookups: `registry.capability(mime,
filename, field)` (first matching plugin's field) + `registry.get(id)`.

- **Required:** `id`, `matches(mimeType, filename)`, and
  `async extract({ mimeType, filename, contentPath, loadBuffer }) -> { metadata:
  [{key, value, type}], fulltext? }`. Multiple plugins run per file and their
  metadata is **merged** (tagged with the plugin `id`); per-plugin failure is
  isolated. `contentPath` is the on-disk path (for ffmpeg/ffprobe); `loadBuffer()`
  lazily returns the bytes (for sharp/text) — so a multi-GB video is never read
  into memory just to probe it.
- **`thumbnail = { contentType, async generate(source) -> Buffer|null }`** — the
  single pre-generated grid/detail image (worker-built, cached, served at
  `/api/files/:id/thumbnail`). Each plugin decides: plugin-image resizes to
  512 webp, plugin-video extracts a frame, plugin-audio returns a shipped default
  image. Replaces the old `renderer.thumbnail` preset.
- **`preview(file, helpers) -> htmlString|null`** — the detail-page preview HTML
  (a plugin owns it; the core injects the string). `helpers` = `{ escapeHtml,
  isPublic, url:{ download, thumbnail, serve(subpath), publicServe(subpath),
  publicOriginal, asset(name) } }`. `serve`/`publicServe` build the generic
  serving URLs (the plugin composes the subpath — no format knowledge in the
  helper); `asset` maps to the plugin's own shipped `assets/`.
- **`serving = { formats, version?, async serve({source, segments, ext}, api),
  async pregenerate?({source}, api) }`** — the single serving capability
  (**replaces the old `renderer` + `streamer`**). `formats` are the output
  extensions the plugin serves; the core dispatches by the request's final-segment
  extension (see "Serving" below). `serve` returns a **descriptor** (built via the
  `api`) that the core streams; `pregenerate` (optional, worker-time) builds
  expensive artifacts (HLS) and returns a `stream_type` tag. The plugin never
  touches the filesystem/HTTP — it only calls the `api`:
  - `api.rendition(cacheKey, ext, contentType, produce)` — cached single derived
    file (on-the-fly image variants); `produce()→Buffer`.
  - `api.member(memberPath, contentType)` — a member of the pre-generated bundle
    (HLS); null if absent.
  - `api.bytes(buffer, contentType)` — inline bytes.
  - `api.buildBundle(async (outDir)=>{…})` — pregenerate-only; builds into a temp
    dir, published atomically under the file's bundle key.
- **`assets`** — absolute path to a directory of static files the plugin ships
  (player JS, hls.js, default images), served generically at
  `/plugin-assets/:id/*` (sanitized). Set via
  `fileURLToPath(new URL('./assets/', import.meta.url))`.
- **`source`** (passed to extract/thumbnail/serving) =
  `{ contentHash, contentPath, mimeType, filename, loadBuffer() }`.
- Core plugins: `text`, `image` (EXIF/dimensions + `serving` resize), `video`
  (ffmpeg: poster thumbnail + `serving` HLS ABR), `audio` (ffprobe metadata +
  default thumbnail; progressive Range serving needs no `serving`). Heavy deps
  (sharp, ffmpeg-static/ffprobe-static) stay inside the plugin packages.

### Deferred (not in v1)

- **Share links** — want to think through the best approach first.
- **Tags and custom fields** — later step.
- **rsync sync** of a local folder — later step.
- Markdown editor, output editors, mobile app — future.

## Architecture (v1)

Full design lives in the plan file referenced below; summary:

- **Storage:** single `--data-dir` holds `gemme.db`, content-addressed `blobs/`
  (sharded by hash prefix, dedup by SHA-256), and `derived/` thumbnails.
- **Data model:** `users`, `files` (content_hash, byte_size, mime_type,
  extraction_status, thumbnail_type, soft delete), `file_metadata` (typed EAV +
  source), `metadata_fts` (FTS5, keyed by `file_id`), `jobs` (durable queue),
  `schema_migrations`.
- **Background worker:** on upload the file's **core metadata (filename, ext,
  type, mime, size, created) + a filename FTS row are indexed synchronously**
  (`indexFileCore`, inside the create transaction) so it's *searchable
  immediately* — before extraction. An in-process job runner then polls `jobs`
  and fills in plugin metadata (dimensions, EXIF, body text, thumbnail) later,
  running all matching plugins and merging output. Core is computed once in
  `metadata/core.js`, shared by upload-time indexing and extraction.
- **Search DSL:** parser → AST (free text vs `field op value`) → SQL compiler
  (FTS5 MATCH for text, typed EAV joins for filters).

### Upload wire format (decided during build)

Rather than pull in a multipart parser, uploads are **one file per request as a
raw body**: `POST /api/files` (always a new file) with the bytes as the request
body, `X-Filename` (URL-encoded) and
`Content-Type` headers carrying the rest. Streams straight into the blob store.
Bulk upload = many parallel requests. Isolated in `src/server/upload.js` so it can
be swapped for multipart later. (We own both client and server, so no HTML-form
multipart is needed for v1.)

## Build order (v1 milestones, each TDD)

Tests use Node's built-in `node:test` + `assert` (zero deps); HTTP tested via
`fetch` against an ephemeral server on a temp data-dir. Run with `npm test`.

1. [DONE] Skeleton + storage core (CLI, config, DB module, migration runner, blob store).
2. [DONE] Users + auth (create-user, login/session, HTTP router + middleware).
3. [DONE] Files API (upload, list, get, delete, download, provenance). One blob per
   file — no versions (see "Removing versions").
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
monorepo with a config-driven plugin system (see below). Tests green (`npm test`). Verified
end-to-end against a live server: create-user → login → drag/upload → background
extraction → DSL search → download → detail pages.

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
- Searches **non-deleted files**. Empty query = list all.
- Compiles to `EXISTS (… file_metadata …)` per clause + FTS subqueries.
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
  plugin-image/  @gemme/plugin-image  dimensions + EXIF (exifr) + resize/thumb (sharp)
  plugin-video/  @gemme/plugin-video  ffprobe metadata + poster frame + HLS ABR
                                        (ffmpeg-static/ffprobe-static); ships hls.js
  plugin-audio/  @gemme/plugin-audio  ffprobe metadata + default thumbnail
                                        (progressive playback via core Range)
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
- **Serving — one extension-dispatch mechanism, plugin-driven.** The core knows
  no format. A serving request's **final path segment's extension** selects the
  plugin (the first that `matches` the file *and* lists the extension in
  `serving.formats`); that plugin's `serve` returns a **descriptor** and the core
  streams it. Two thin routes (`routes/serving.js`, registered LAST so specific
  routes win): `GET /api/files/:id/*rest` (auth) and `GET /i/:id/*rest` (public,
  via `resolvePublic`). A router `*name` wildcard captures nested member paths
  (`360p/seg_000.ts`); segments are traversal-sanitized. Engine: **`lib/serving.js`**
  (`servingFor`, `makeServingApi`, `specSig`, `makeSource`, `thumbnailFor`,
  `getThumbnail`) — it absorbed the old `renditions.js` + `bundles.js`.
  - **Descriptor** = `{ size, contentType, etag, open(range) }` (or via
    `api.bytes`) — exactly what `streamBytes` consumes, so Range/206, ETag/304 and
    caching are uniform. The `api` (rendition/member/bytes/buildBundle) owns the
    derived store + cache keys; plugins stay HTTP-free and never see the filesystem.
  - **On-the-fly** (image variants, `api.rendition`): content-addressed in the
    **derived store** (`<dataDir>/derived/<sourceHash>.<sig>.<ext>`), generated
    once on first request, shared across collections.
  - **Pre-generated bundles** (HLS, `api.buildBundle` in `serving.pregenerate`):
    directory storage (`<hash>.<sig>/` members, published by atomic dir rename so a
    half-built bundle is never served). Serving is read-only — a missing member
    404s (still processing); it never triggers an on-request transcode.
  - **Thumbnails** stay a dedicated capability + route: the worker calls the
    plugin's `thumbnail.generate(source)` (via `getThumbnail`), stores it under a
    fixed sig, records `files.thumbnail_type`; served at `GET /api/files/:id/thumbnail`
    (regenerated on demand if the cache was cleared). No capability → gray box.
  - **HTTP Range (206)** is core (`streamBytes` in `server/render-response.js`,
    `{start,end}` through blob/derived read streams): `/api/files/:id/download`,
    `/i/:id`, and served members all support it (audio/progressive-video seeking).
  - **Detail preview** is the plugin's `preview(file, helpers)` HTML, invoked in
    `routes/pages.js` and injected by `render.js` `renderDetail` — no per-format
    preview branch in core. **Plugin assets** (player JS, hls.js, default images)
    ship inside the plugin (`assets` dir) and serve at `/plugin-assets/:id/*`.
  - The registry reaches request handlers via `ctx.registry` (threaded through
    `createApp`/`startServer`).
- **RAW images (`plugin-image`, done).** Camera RAW (`arw sr2 srf cr2 cr3 nef nrw
  raf orf rw2 dng pef srw 3fr iiq rwl mrw dcr kdc mos`) is supported without new
  deps. `matches` accepts RAW **by extension** (browsers send
  `application/octet-stream`). sharp can't decode RAW, so the renderer's `run()`
  (and `extract`'s dimension read) always work from an **embedded JPEG preview**;
  there are two RAW families:
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
  re-extracted (re-run `runExtraction` per file) to pick it up.
- **Extension-first categorization.** `metadata/core.js` `categorize(mimeType,
  filename)` classifies by **extension** first (an `EXT_CATEGORY` map incl. RAW →
  `image`), falling back to MIME when the extension is unknown/absent — so a
  RAW upload is `type:image` in the facet/filter despite its generic MIME. The
  detail page (`render.js`) also decides the preview by extension: web-renderable
  images (`png jpg jpeg gif webp avif svg`) show the full `/download`; other
  images (RAW, heic, tiff) show the generated `/thumbnail` (raw bytes won't render
  in a browser); everything else has no preview. RAW ext list is duplicated in
  `plugin-image` `RAW_EXT` and core `EXT_CATEGORY` (separate packages) — keep in sync.
  - **Image cache policy (one immutable URL per file).** Because a file IS one
    immutable blob (no versions), its bytes never change for its lifetime, so the
    by-id URLs `/api/files/:id/download`, `/api/files/:id/thumbnail`, the plugin
    serving routes (`/api/files/:id/*rest`, `/i/:id/*rest`), and the public
    `/i/:id` are ALL served **`immutable`** (1-year, no
    revalidation) in production, with a strong `ETag` (the content hash, honoring
    `If-None-Match` → 304). One `imageCacheControl(ctx)` helper (in
    `server/render-response.js`) drives every route — there is no more
    version-pinned-vs-bare duality. The one thing that can break the immutable
    promise is **re-running extraction locally** (a plugin/`sharp` change rewrites
    a thumbnail for the same file), so **dev mode never sends `immutable`** — a
    `dev` config flag (`--dev` / `GEMME_DEV`, threaded to `ctx.dev`; the repo's
    `npm run dev` sets it) forces `no-cache`. Tradeoff on the public routes:
    revoking public access (collection → private, or file delete) won't reach
    already-cached CDN/browser copies until the max-age expires — edge access
    control is best-effort, the accepted cost of long-lived caching.
    Files: `server/render-response.js` (`imageCacheControl`), `server/routes/files.js`,
    `server/routes/public.js`, `lib/config.js` (`dev`), `server/index.js` (`ctx.dev`);
    tests: `server/test/thumbnail.test.js`, `server/test/http-public.test.js`.
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
  `server/routes/collections.js`, migration 004.
- **Collection visibility (public serving, done).** `collections.visibility`
  (`private` default | `public`, migration 004) cascades to the whole subtree: a
  file is public if it's in any collection whose ancestor (incl. self) is public
  (`isFilePublic`, a closure EXISTS mirroring the collection filter). Toggle via
  `PATCH /api/collections/:id {visibility}`; the `/collections` manager has a
  make-public/private button + badge, the sidebar shows a dot, and a public file's
  detail page shows its `/i/:id` URL + a copyable `srcset` snippet. **Public
  routes** (unauthenticated), 404 (never 403) for non-public/missing:
  - `GET /i/:id` (`server/routes/public.js`) → original bytes (any type).
  - `GET /i/:id/*rest` (`server/routes/serving.js`) → plugin serving by extension
    dispatch: an image rendition `/i/42/w=800,fit=cover.webp` (params `w,h,fit,q`
    clamped w/h ≤ 4096, q 1–100), or the public HLS stream `/i/42/master.m3u8` →
    `/i/42/360p/seg_000.ts`. Same engine + caches as the authenticated
    `/api/files/:id/*rest`.
  - **Cache:** `immutable` (1-year) in prod / `no-cache` in dev, strong ETag
    (`"<hash>"` / `"<hash>-<sig>"`), honoring `If-None-Match` → 304 — the same
    `imageCacheControl` policy as the auth routes (a file's bytes never change).
    Shared streaming helper: `server/render-response.js`.
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
  thumbnail/status/size/name — changed, so unchanged thumbnails don't
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
  → 004 collections) plus incremental additions (005 stream_type): since nothing is
  deployed yet, early `ALTER TABLE`s were folded back into the original `CREATE TABLE`s
  for a clean starting point. Add new schema changes as new numbered migrations from here.
- `lib/storage/` — `blobs.js` (content-addressed, SHA-256; Range-capable read
  stream), `derived.js` (single-file variants + directory **bundles** for HLS).
- `lib/auth/` — `passwords.js` (scrypt), `users.js`, `sessions.js`.
- `lib/files.js` — file data layer (create/get/list/soft-delete + dedup).
- `lib/collections.js` — collection tree + closure maintenance + membership.
- `lib/facets.js` — distinct-value + count aggregation per metadata key.
- `lib/serving.js` — the unified serving engine (`servingFor`, `makeServingApi`
  with rendition/member/bytes/buildBundle, `specSig`, lazy `makeSource`,
  `thumbnailFor`/`getThumbnail`). Absorbed the old `renditions.js` + `bundles.js`.
- `lib/bus.js` — in-process `change` pub/sub shared by routes + worker + SSE.
- `lib/metadata/` — `core.js` (shared core-metadata), `store.js` (typed EAV + FTS;
  `indexFileCore` for upload-time indexing).
- `lib/search/` — `dsl.js` (parse/compile), `compose.js` (state⇄string⇄URL),
  `search.js` (`searchFiles`, `paginatedSearch`).
- `lib/plugins/` — `registry.js` (`PluginRegistry` + apiVersion check + `capability`/
  `get` lookups), `config.js` (loader).
- `worker/` — `extract.js` (core + plugin merge + `pregenerateArtifacts`:
  thumbnail + `serving.pregenerate` bundle), `queue.js`, `index.js`
  (`ExtractionWorker`, `runPending`; emits `change`; requires an explicit
  registry). Imports from `../lib/…`.
- `server/` — `index.js` (createApp; threads `registry` onto `ctx`; registers
  `routes/serving.js` LAST), `router.js` (`:name` + `*name` wildcard),
  `respond.js`, `render-response.js` (shared Range-aware `streamBytes` + media
  cache policy + 304), `middleware.js`, `upload.js`,
  `routes/{auth,files,search,pages,events,facets,collections,public,serving}.js`
  (`serving.js` = the `*rest` extension-dispatch routes; `pages.js` also serves
  `/plugin-assets/:id/*`).
- `web/` — `render.js` (`renderDetail` injects the plugin's `preview` HTML;
  `previewHelpers`) + `public/{app.js,styles.css}`; `<gemme-files>` does keyed
  reconciliation + SSE, `<gemme-search>` emits query events. No per-format player
  code in core — plugin-video ships its own `player.js` + `hls.js` under `assets/`.
- Tests live in each package's `test/`; `server/test/helpers/` boots an ephemeral
  app and provides a `fakeRegistry()` so server tests don't depend on the real
  plugin packages (those are tested in their own packages).

### Not yet done / known gaps

- `@gemme/*` packages are **not published to npm** yet, so `gemme init` with a
  real install only works once published; today the working path is the in-repo
  dev instance (workspace symlinks). Publishing is a future step.
- Thumbnails exist for **images** (sharp), **video** (ffmpeg poster frame), and
  **audio** (a shipped default image). PDF/etc. are future plugins — they just add
  a `thumbnail` capability; the derived-store + serving machinery already handles it.
- **HLS is VOD, pre-generated** on upload in the in-process worker; a long
  transcode occupies the worker until it finishes (fine for a single box; a
  dedicated queue/concurrency is a future step). Non-web **audio** transcode
  (e.g. flac→mp3) is deferred — audio v1 is progressive Range over native formats.

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
