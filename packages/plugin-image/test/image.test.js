import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import imagePlugin from '../index.js';

const TARGET = { maxEdge: 256, format: 'webp' };
// A real, decodable image (sharp-created) so the thumbnail path exercises sharp.
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

test('generates a WebP thumbnail bounded by maxEdge, honoring the target', async () => {
  const p = imagePlugin({ exif: false });
  const buffer = await realImage(1200, 800);
  const { thumbnail } = await p.extract({ buffer, mimeType: 'image/png', filename: 'big.png', thumbnailTarget: TARGET });
  assert.ok(thumbnail, 'a thumbnail was produced');
  assert.equal(thumbnail.contentType, 'image/webp');
  const meta = await sharp(thumbnail.data).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 256 && meta.height <= 256, `within maxEdge (got ${meta.width}x${meta.height})`);
  assert.equal(meta.width, 256, 'longest edge scaled to the target');
});

test('skips thumbnail when a prior plugin already produced one', async () => {
  const p = imagePlugin();
  const buffer = await realImage(400, 400);
  const res = await p.extract({
    buffer,
    mimeType: 'image/png',
    filename: 'x.png',
    thumbnailTarget: TARGET,
    prior: { thumbnail: true, metadata: [] },
  });
  assert.equal(res.thumbnail, undefined, 'no thumbnail generated when prior.thumbnail is set');
  assert.ok(res.metadata.length > 0, 'metadata is still extracted');
});

test('no thumbnail when target is absent', async () => {
  const p = imagePlugin({ exif: false });
  const buffer = await realImage(300, 300);
  const res = await p.extract({ buffer, mimeType: 'image/png', filename: 'x.png', thumbnailTarget: null });
  assert.equal(res.thumbnail, undefined);
});
