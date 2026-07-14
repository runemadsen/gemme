import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import imagePlugin from '../index.js';

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
  const { metadata } = await p.extract({ buffer: png(1920, 1080), mimeType: 'image/png', filename: 'w.png' });
  const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
  assert.equal(byKey.width, 1920);
  assert.equal(byKey.height, 1080);
  assert.equal(byKey.orientation, 'landscape');
});

test('EXIF parse failure on a non-EXIF buffer is swallowed (dimensions still returned)', async () => {
  const p = imagePlugin({ exif: true });
  const { metadata } = await p.extract({ buffer: png(10, 20), mimeType: 'image/png', filename: 'p.png' });
  const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
  assert.equal(byKey.width, 10);
  assert.equal(byKey.orientation, 'portrait');
});

test('extract returns metadata only (thumbnails come from the renderer now)', async () => {
  const { extract } = imagePlugin({ exif: false });
  const res = await extract({ buffer: png(10, 20), mimeType: 'image/png', filename: 'p.png' });
  assert.equal(res.thumbnail, undefined);
  assert.ok(res.metadata.length >= 2);
});

// --- renderer capability ---------------------------------------------------

test('renderer.normalize clamps and validates params', () => {
  const { renderer } = imagePlugin();
  assert.deepEqual(renderer.normalize({ w: '800', h: '600', q: '80', fit: 'cover' }), {
    width: 800,
    height: 600,
    fit: 'cover',
    quality: 80,
  });
  assert.deepEqual(renderer.normalize({ w: '999999' }), { width: 4096 }); // clamp high
  assert.deepEqual(renderer.normalize({ q: '0' }), { quality: 1 }); // clamp low
  assert.deepEqual(renderer.normalize({ w: 'abc' }), {}); // non-numeric ignored
  assert.deepEqual(renderer.normalize({}), {}); // reformat-only
  assert.throws(() => renderer.normalize({ fit: 'nonsense' }), /fit/);
});

test('renderer.run resizes + reformats a real image', async () => {
  const { renderer } = imagePlugin();
  const buffer = await realImage(1200, 800);
  const out = await renderer.run({ buffer, filename: 'big.png', mimeType: 'image/png' }, { width: 256, format: 'webp' });
  assert.equal(out.contentType, 'image/webp');
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256, 'longest edge scaled to the requested width');
});

test('renderer.run reformats without resizing (jpg -> jpeg encoder)', async () => {
  const { renderer } = imagePlugin();
  const buffer = await realImage(64, 48);
  const out = await renderer.run({ buffer, filename: 'x.png', mimeType: 'image/png' }, { format: 'jpg' });
  assert.equal(out.contentType, 'image/jpeg');
  const meta = await sharp(out.data).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 64, 'no resize when no dimensions given');
});

test('renderer.run returns null for an undecodable buffer', async () => {
  const { renderer } = imagePlugin();
  const out = await renderer.run({ buffer: Buffer.from('not an image'), filename: 'x.png', mimeType: 'image/png' }, { format: 'webp' });
  assert.equal(out, null);
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

test('renderer.run renders RAW from its embedded JPEG preview', async () => {
  const { renderer } = imagePlugin();
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
  const raf = await fakeRaf(jpeg);
  const out = await renderer.run({ buffer: raf, filename: 'DSCF1.RAF', mimeType: 'application/octet-stream' }, { width: 200, format: 'webp' });
  assert.ok(out, 'rendered from the embedded preview');
  assert.equal(out.contentType, 'image/webp');
  assert.equal((await sharp(out.data).metadata()).width, 200);
});

test('renderer.run returns null for an undecodable RAW', async () => {
  const { renderer } = imagePlugin();
  const out = await renderer.run(
    { buffer: Buffer.from('not really a raf'), filename: 'broken.raf', mimeType: 'application/octet-stream' },
    { format: 'webp' }
  );
  assert.equal(out, null);
});
