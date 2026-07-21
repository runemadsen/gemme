import { test } from 'node:test';
import assert from 'node:assert/strict';
import audioPlugin from '../index.js';

test('factory returns a valid plugin stamped with apiVersion', () => {
  const p = audioPlugin();
  assert.equal(p.id, 'audio');
  assert.equal(p.apiVersion, 1);
  assert.equal(typeof p.preview, 'function');
  assert.equal(p.streamer, undefined, 'audio has no streamer (core Range serves it)');
});

test('matches audio by mime and by extension (generic mime)', () => {
  const p = audioPlugin();
  assert.equal(p.matches('audio/mpeg', 'a.mp3'), true);
  assert.equal(p.matches('application/octet-stream', 'song.FLAC'), true);
  assert.equal(p.matches('application/octet-stream', 'x.m4a'), true);
  assert.equal(p.matches('video/mp4', 'a.mp4'), false);
});

test('thumbnail returns the shared default image for every audio file', async () => {
  const { thumbnail } = audioPlugin();
  assert.equal(thumbnail.contentType, 'image/svg+xml');
  const a = await thumbnail.generate({ filename: 'one.mp3' });
  const b = await thumbnail.generate({ filename: 'two.flac' });
  assert.ok(Buffer.isBuffer(a) && a.length > 0);
  assert.ok(a.equals(b), 'same default image regardless of source');
  assert.match(a.toString('utf8'), /<svg/);
});

test('preview renders a native <audio> element pointing at the download', () => {
  const p = audioPlugin();
  const h = {
    escapeHtml: (s) => s,
    isPublic: true,
    url: { download: () => '/api/files/5/download', publicOriginal: () => '/i/5' },
  };
  const html = p.preview({ id: 5 }, h);
  assert.match(html, /<audio controls src="\/api\/files\/5\/download">/);
  assert.doesNotMatch(html, /\/i\/5/); // public embed help lives in publicEmbed
});

test('publicEmbed surfaces a copyable public <audio> snippet', () => {
  const p = audioPlugin();
  const h = {
    escapeHtml: (s) => s,
    url: { download: () => '/api/files/5/download', publicOriginal: () => '/i/5' },
  };
  const html = p.publicEmbed({ id: 5 }, h);
  assert.match(html, /<audio controls src="\/i\/5"><\/audio>/);
});
