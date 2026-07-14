import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../utils.js';

function png(w, h) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0); // first 4 bytes of PNG signature
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function gif(w, h) {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpeg(w, h) {
  // FFD8 SOI, then SOF0 segment carrying dimensions.
  const b = Buffer.alloc(24);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffc0, 2); // SOF0 marker
  b.writeUInt16BE(17, 4); // segment length
  b.writeUInt8(8, 6); // precision
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

test('parses PNG dimensions', () => {
  assert.deepEqual(imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
});

test('parses GIF dimensions', () => {
  assert.deepEqual(imageSize(gif(640, 480)), { width: 640, height: 480 });
});

test('parses JPEG dimensions from SOF0', () => {
  assert.deepEqual(imageSize(jpeg(800, 600)), { width: 800, height: 600 });
});

test('returns null for non-image / too-short buffers', () => {
  assert.equal(imageSize(Buffer.from('not an image at all!!')), null);
  assert.equal(imageSize(Buffer.alloc(4)), null);
});
