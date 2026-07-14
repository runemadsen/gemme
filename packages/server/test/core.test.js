import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, coreMetadata } from '../src/lib/metadata/core.js';

test('categorize decides by extension first (RAW = image despite generic mime)', () => {
  // Browsers send octet-stream for RAW; the extension must win.
  assert.equal(categorize('application/octet-stream', 'shot.arw'), 'image');
  assert.equal(categorize('application/octet-stream', 'holiday.RAF'), 'image');
  assert.equal(categorize('application/octet-stream', 'x.dng'), 'image');
  // Web images by extension too.
  assert.equal(categorize('application/octet-stream', 'a.jpg'), 'image');
});

test('categorize falls back to mime when the extension is unknown/absent', () => {
  assert.equal(categorize('image/png', 'noext'), 'image');
  assert.equal(categorize('application/pdf', 'paper'), 'pdf');
  assert.equal(categorize('text/plain', ''), 'text');
  assert.equal(categorize('application/octet-stream', 'mystery.bin'), 'other');
});

test('categorize keeps classifying known non-image extensions', () => {
  assert.equal(categorize('application/octet-stream', 'clip.mp4'), 'video');
  assert.equal(categorize('application/octet-stream', 'song.mp3'), 'audio');
  assert.equal(categorize('application/octet-stream', 'readme.md'), 'text');
});

test('coreMetadata tags a RAW upload as type:image', () => {
  const rows = coreMetadata({
    filename: 'DSC001.arw',
    mimeType: 'application/octet-stream',
    byteSize: 1234,
    createdAt: '2024-01-01T00:00:00.000Z',
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  assert.equal(byKey.type, 'image');
  assert.equal(byKey.ext, 'arw');
  assert.equal(byKey.mime, 'application/octet-stream');
});
