import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import imagePlugin, { parseSpecParams, normalizeSpec } from '../index.js';

// The core hands serving a `source` with a lazy `loadBuffer()` (see server
// lib/serving.js `makeSource`). Mirror just that shape in tests.
function src(buffer, filename = 'x.png', mimeType = 'image/png') {
  return { filename, mimeType, contentHash: 'h', contentPath: '', loadBuffer: async () => buffer };
}

// A stub of the core serving `api`: `rendition` just runs the producer and
// returns its bytes + content type (the real cache/streaming lives in the core).
const stubApi = {
  async rendition(_key, ext, contentType, produce) {
    const data = await produce();
    return data ? { data, contentType, ext } : null;
  },
};

// Drive plugin-image's serving.serve for a single-segment spec like 'w=256.webp'.
function serve(plugin, source, segment) {
  const ext = segment.slice(segment.lastIndexOf('.') + 1).toLowerCase();
  return plugin.serving.serve({ source, segments: [segment], ext }, stubApi);
}

// A real, decodable image (sharp-created) so the render path exercises sharp.
async function realImage(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .png()
    .toBuffer();
}

function png(w, h) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test('factory returns a valid plugin stamped with apiVersion', () => {
  const p = imagePlugin();
  assert.equal(p.id, 'image');
  assert.equal(p.apiVersion, 1);
  assert.equal(typeof p.matches, 'function');
});

test('matches images by mime and extension', () => {
  const p = imagePlugin();
  assert.equal(p.matches('image/png', 'x.png'), true);
  assert.equal(p.matches('application/octet-stream', 'photo.JPG'), true);
  assert.equal(p.matches('text/plain', 'a.txt'), false);
});

test('matches RAW formats by extension despite a generic mime', () => {
  const p = imagePlugin();
  // Browsers send octet-stream for RAW; matching must key off the extension.
  for (const name of ['shot.arw', 'shot.RAF', 'a.nef', 'b.cr2', 'c.dng', 'd.orf']) {
    assert.equal(p.matches('application/octet-stream', name), true, name);
  }
  assert.equal(p.matches('application/octet-stream', 'notes.txt'), false);
});

test('extracts dimensions + orientation from a PNG', async () => {
  const p = imagePlugin({ exif: false });
  const { metadata } = await p.extract({ loadBuffer: async () => png(1920, 1080), mimeType: 'image/png', filename: 'w.png' });
  const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
  assert.equal(byKey.width, 1920);
  assert.equal(byKey.height, 1080);
  assert.equal(byKey.orientation, 'landscape');
});

test('EXIF parse failure on a non-EXIF buffer is swallowed (dimensions still returned)', async () => {
  const p = imagePlugin({ exif: true });
  const { metadata } = await p.extract({ loadBuffer: async () => png(10, 20), mimeType: 'image/png', filename: 'p.png' });
  const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
  assert.equal(byKey.width, 10);
  assert.equal(byKey.orientation, 'portrait');
});

test('extract returns metadata only (thumbnail is its own capability now)', async () => {
  const { extract } = imagePlugin({ exif: false });
  const res = await extract({ loadBuffer: async () => png(10, 20), mimeType: 'image/png', filename: 'p.png' });
  assert.equal(res.thumbnail, undefined);
  assert.ok(res.metadata.length >= 2);
});

// --- thumbnail capability --------------------------------------------------

test('thumbnail.generate makes a 512px webp from a real image', async () => {
  const { thumbnail } = imagePlugin();
  assert.equal(thumbnail.contentType, 'image/webp');
  const buffer = await realImage(2000, 1000);
  const out = await thumbnail.generate(src(buffer, 'big.png'));
  assert.ok(Buffer.isBuffer(out) && out.length > 0);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 512);
});

test('thumbnail.generate returns null for an undecodable buffer', async () => {
  const { thumbnail } = imagePlugin();
  assert.equal(await thumbnail.generate(src(Buffer.from('nope'), 'x.png')), null);
});

// --- preview capability ----------------------------------------------------

const helpers = (isPublic = false) => ({
  escapeHtml: (s) => s,
  isPublic,
  url: {
    download: () => '/api/files/9/download',
    thumbnail: () => '/api/files/9/thumbnail',
    publicServe: (spec) => `/i/9/${spec}`,
  },
});

test('preview: web image points at the download; RAW uses the thumbnail', () => {
  const p = imagePlugin();
  assert.match(p.preview({ id: 9, original_filename: 'a.jpg' }, helpers()), /src="\/api\/files\/9\/download"/);
  const raw = p.preview({ id: 9, original_filename: 'x.arw', thumbnail_type: 'image/webp' }, helpers());
  assert.match(raw, /src="\/api\/files\/9\/thumbnail"/);
  assert.equal(p.preview({ id: 9, original_filename: 'x.arw', thumbnail_type: null }, helpers()), null);
});

test('preview: public image adds an srcset snippet', () => {
  const p = imagePlugin();
  const html = p.preview({ id: 9, original_filename: 'a.jpg' }, helpers(true));
  assert.match(html, /srcset=/);
  assert.match(html, /\/i\/9\/w=800\.webp/);
});

// --- serving capability ----------------------------------------------------

test('parseSpecParams + normalizeSpec clamp and validate a spec segment', () => {
  assert.deepEqual(parseSpecParams('w=800,h=600,fit=cover,q=80.webp'), {
    w: '800',
    h: '600',
    fit: 'cover',
    q: '80',
  });
  assert.deepEqual(normalizeSpec({ w: '800', h: '600', q: '80', fit: 'cover' }), {
    width: 800,
    height: 600,
    fit: 'cover',
    quality: 80,
  });
  assert.deepEqual(normalizeSpec({ w: '999999' }), { width: 4096 }); // clamp high
  assert.deepEqual(normalizeSpec({ q: '0' }), { quality: 1 }); // clamp low
  assert.deepEqual(normalizeSpec({ w: 'abc' }), {}); // non-numeric ignored
  assert.deepEqual(normalizeSpec({}), {}); // reformat-only
  assert.throws(() => normalizeSpec({ fit: 'nonsense' }), /fit/);
});

test('serving lists image output formats', () => {
  assert.deepEqual(imagePlugin().serving.formats, ['webp', 'jpg', 'jpeg', 'png', 'avif']);
});

test('serving.serve resizes + reformats a real image', async () => {
  const p = imagePlugin();
  const out = await serve(p, src(await realImage(1200, 800), 'big.png'), 'w=256.webp');
  assert.equal(out.contentType, 'image/webp');
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256, 'longest edge scaled to the requested width');
});

test('serving.serve reformats without resizing (jpg -> jpeg encoder)', async () => {
  const p = imagePlugin();
  const out = await serve(p, src(await realImage(64, 48), 'x.png'), 'photo.jpg');
  assert.equal(out.contentType, 'image/jpeg');
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 64, 'no resize when no dimensions given');
});

test('serving.serve returns null for an undecodable buffer', async () => {
  const out = await serve(imagePlugin(), src(Buffer.from('not an image'), 'x.png'), 'w=100.webp');
  assert.equal(out, null);
});

test('serving.serve throws on an invalid transform param (→ core 400)', async () => {
  const s = src(await realImage(10, 10));
  await assert.rejects(() => serve(imagePlugin(), s, 'fit=nonsense.webp'), /fit/);
});

// Build a minimal Fuji RAF: the `FUJIFILMCCD-RAW ` magic + a JPEG preview whose
// offset/length are recorded at 0x54/0x58 (big-endian), like a real .raf.
async function fakeRaf(jpeg) {
  const header = Buffer.alloc(0x5c);
  header.write('FUJIFILMCCD-RAW ', 0, 'latin1');
  header.writeUInt32BE(0x5c, 0x54); // preview offset
  header.writeUInt32BE(jpeg.length, 0x58); // preview length
  return Buffer.concat([header, jpeg]);
}

test('serving.serve renders RAW from its embedded JPEG preview', async () => {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
  const raf = await fakeRaf(jpeg);
  const out = await serve(imagePlugin(), src(raf, 'DSCF1.RAF', 'application/octet-stream'), 'w=200.webp');
  assert.ok(out, 'rendered from the embedded preview');
  assert.equal(out.contentType, 'image/webp');
  assert.equal((await sharp(out.data).metadata()).width, 200);
});

test('serving.serve returns null for an undecodable RAW', async () => {
  const out = await serve(
    imagePlugin(),
    src(Buffer.from('not really a raf'), 'broken.raf', 'application/octet-stream'),
    'w=100.webp'
  );
  assert.equal(out, null);
});
