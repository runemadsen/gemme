# Gemme HTTP API

The JSON HTTP API holds all of Gemme's functionality; the web UI is just a client
of it. Everything runs in one process (default `http://localhost:4321`).

## Conventions

- **Auth.** Most endpoints require a logged-in session. `POST /api/login` sets a
  `Set-Cookie` session cookie; send that cookie on subsequent requests. Missing/
  invalid session → `401`. The **public** (`/i/...`) routes need no auth.
- **Content type.** JSON endpoints accept and return `application/json`. File
  **uploads** are raw bytes (see below), not multipart.
- **Errors.** Failures return the matching status (`400/401/404/409/410/415/416`)
  with a JSON `{ "error": "message" }` body.
- **IDs** are positive integers. A malformed id → `400`.

### Upload wire format

Uploads are **one file per request, raw body** (no multipart):

```
POST /api/files
Content-Type: <the file's MIME type>
X-Filename: <URL-encoded original filename>   (required)

<raw file bytes>
```

Bulk upload = many parallel `POST /api/files` requests.

### The `file` object

```jsonc
{
  "id": 42,
  "original_filename": "clip.mp4",
  "content_hash": "…sha256…",
  "byte_size": 60927,
  "mime_type": "video/mp4",
  "extraction_status": "pending | done | failed",
  "thumbnail_type": "image/webp | image/svg+xml | null",
  "stream_type": "hls | null",          // a streaming bundle is available
  "created_by": 1,
  "created_at": "2026-07-20T…Z",
  "updated_at": "2026-07-20T…Z",
  "deleted_at": null
}
```

`GET /api/files` and `GET /api/search` return a projected subset (no
`created_by`/`deleted_at`).

---

## Auth

| Method | Path          | Auth | Description |
| ------ | ------------- | ---- | ----------- |
| POST   | `/api/login`  | —    | Body `{ email, password }`. On success sets the session cookie and returns `{ user }`. `401` on bad credentials. |
| POST   | `/api/logout` | —    | Clears the session cookie. Returns `{ ok: true }`. |
| GET    | `/api/me`     | ✓    | The current user: `{ user }`. |

> Users are created out-of-band with the CLI (`gemme create-user`), not via the API.

---

## Files

| Method | Path                          | Auth | Description |
| ------ | ----------------------------- | ---- | ----------- |
| POST   | `/api/files`                  | ✓    | Upload one file (raw body, see wire format). `201 { file, skipped: false }`. If a non-deleted file already has the **same filename AND content hash**, nothing is created: `200 { file, skipped: true }`. (Uploading "a new version" is just another upload → a new file.) |
| GET    | `/api/files`                  | ✓    | List non-deleted files, newest-updated first. Query: `limit` (1–200, default 50), `offset`. Returns `{ items, total, limit, offset }`. |
| GET    | `/api/files/:id`              | ✓    | One file: `{ file }`. `404` if missing/deleted. |
| DELETE | `/api/files`                  | ✓    | Bulk soft-delete. Body `{ fileIds: [1,2,…] }` (non-empty). Returns `{ ok: true, count }`. Use a one-element array for a single file. |
| GET    | `/api/files/:id/download`     | ✓    | The original bytes. Supports HTTP **Range** (`206` + `Content-Range`, `Accept-Ranges: bytes`). Immutable cache (prod). `410` if the blob is gone. |
| GET    | `/api/files/:id/thumbnail`    | ✓    | The file's single pre-generated thumbnail image (`Content-Type` per plugin, e.g. `image/webp`). `404` if the file's plugins provide no thumbnail. Immutable cache (prod). |
| GET    | `/api/files/:id/*rest`        | ✓    | **Plugin serving (extension dispatch).** The bytes are produced by whichever plugin matches the file *and* registered the request's output extension — e.g. an image variant `w=800.webp`, an HLS manifest `master.m3u8`, or a segment `360p/seg_000.ts`. Range/206, ETag/304, and immutable caching are handled uniformly by the core. `404` when no plugin serves that extension or the artifact isn't ready. This is the authenticated mount for a file's owner; the public mirror is `GET /i/:id/*rest`. |

### Extension dispatch

There is no per-format route in the core. A serving request's **final path
segment's extension** selects the plugin (among those that match the file); that
one plugin decides how to respond, so a single video plugin serves both
`master.m3u8` and `360p/seg_000.ts`. On-the-fly artifacts (image variants) are
generated + cached on first request; expensive ones (HLS) are pre-generated at
upload and served read-only. Path traversal in `*rest` is rejected.

---

## Search & facets

| Method | Path           | Auth | Description |
| ------ | -------------- | ---- | ----------- |
| GET    | `/api/search`  | ✓    | Filter-DSL search. Query params below. Returns `{ items, total, page, perPage, pages, sort, direction }`. Invalid query → `400`. |
| GET    | `/api/facets`  | ✓    | Distinct values + counts per metadata key across the archive. `?keys=ext,type` (comma-separated, ≤20). Returns `{ facets: { ext: [{ value, count }], … } }`. |

**`/api/search` params:** `q` (the DSL query string, default empty = list all),
`sort` (`date` | `name`), `direction` (`asc` | `desc`), `page`, `perPage`.

**DSL grammar** (whitespace-separated terms; any term negatable with a leading `-`):

- Field clause `key<op>value`, ops `:` `=` `!=` `>` `<` `>=` `<=`. `:` = contains
  (text) / equals (number/date); `=` = exact; comparisons need a numeric/date value.
- Value lists (OR within a field): `ext=jpg,png`, `type=image,video`.
- Free text: bare or `"quoted"` words → full-text + filename substring.
- Units: time `ms/s/min/h/d`, bytes `b/kb/mb/gb/tb`.

Example: `mountains type:image width>1920 duration>10s -type:pdf created>2024-01-01`

---

## Collections

| Method | Path                            | Auth | Description |
| ------ | ------------------------------- | ---- | ----------- |
| GET    | `/api/collections`              | ✓    | All collections (flat; build the tree from `parent_id`), each with a descendant-inclusive `fileCount`. `{ collections }`. |
| POST   | `/api/collections`              | ✓    | Create. Body `{ name, parentId? }`. `201 { collection }`. |
| PATCH  | `/api/collections/:id`          | ✓    | Update any of `{ name, parentId, visibility }` (`parentId: null` = move to root; `visibility: 'private' \| 'public'`). `{ collection }`. |
| DELETE | `/api/collections/:id`          | ✓    | Delete the collection and its subtree (files are untouched). `{ ok: true }`. |
| GET    | `/api/files/:id/collections`    | ✓    | The collection ids a file belongs to: `{ collectionIds }`. |
| POST   | `/api/collections/:id/files`    | ✓    | Add a **set** of files to one collection. Body `{ fileIds: [...] }`. `{ ok: true, count }`. |
| DELETE | `/api/collections/:id/files`    | ✓    | Remove a set of files from one collection. Body `{ fileIds: [...] }`. `{ ok: true, count }`. |

Visibility cascades to the subtree: a file is public if it's in any collection
whose ancestor (incl. self) is public.

---

## Public serving (no auth)

Files in a public collection (or a descendant of one) are served without a login.
Non-public/missing ids answer `404` (never `403`, so ids don't leak). A file's
bytes never change, so these carry a long-lived immutable cache (dev: `no-cache`).

| Method | Path            | Description |
| ------ | --------------- | ----------- |
| GET    | `/i/:id`        | The original bytes (any type). Supports HTTP **Range**. |
| GET    | `/i/:id/*rest`  | Public plugin serving (extension dispatch — the same mechanism as `GET /api/files/:id/*rest`). Examples: an image rendition `/i/42/w=800,fit=cover.webp` (params `w,h,fit,q`, clamped w/h ≤ 4096, q 1–100), or the public HLS stream `/i/42/master.m3u8` → `/i/42/360p/seg_000.ts` to embed in any player. `404` when no plugin serves that extension. |

---

## Events

| Method | Path          | Auth | Description |
| ------ | ------------- | ---- | ----------- |
| GET    | `/api/events` | ✓    | Server-Sent Events stream (`text/event-stream`). Emits an `event: change` with a JSON `data` payload (e.g. `{ type: 'created' \| 'extracted' \| 'deleted' \| 'collections' \| 'membership', fileId? }`) whenever the archive may have changed, so clients can refresh without polling. Sends heartbeat comments; stays open. |

---

## Pages & static (HTML / assets)

Not part of the JSON API, but served by the same process:

| Method | Path                        | Auth | Description |
| ------ | --------------------------- | ---- | ----------- |
| GET    | `/`                         | ✓*   | File grid (server-rendered, filtered by the URL's search/filter state). |
| GET    | `/login`                    | —    | Login page. |
| GET    | `/upload`                   | ✓*   | Upload page. |
| GET    | `/collections`              | ✓*   | Collections manager. |
| GET    | `/files/:id`                | ✓*   | File detail page (preview HTML comes from the matching plugin). |
| GET    | `/static/:file`             | —    | Core static assets (`app.js`, `styles.css`). |
| GET    | `/plugin-assets/:id/*path`  | —    | A plugin's shipped static assets (e.g. `plugin-video`'s `player.js` / `hls.js`). Path traversal is rejected. |

`✓*` = redirects to `/login` when not authenticated.
