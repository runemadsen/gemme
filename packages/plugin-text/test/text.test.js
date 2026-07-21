import { test } from 'node:test';
import assert from 'node:assert/strict';
import textPlugin from '../index.js';

// The core passes extract a lazy `loadBuffer()` (see server worker/extract.js).
const src = (buffer) => ({ loadBuffer: async () => buffer });

test('factory returns a valid plugin stamped with apiVersion', () => {
  const p = textPlugin();
  assert.equal(p.id, 'text');
  assert.equal(p.apiVersion, 1);
});

test('matches text by mime and extension', () => {
  const p = textPlugin();
  assert.equal(p.matches('text/markdown', 'a.md'), true);
  assert.equal(p.matches('application/json', 'a.json'), true);
  assert.equal(p.matches('', 'notes.txt'), true);
  assert.equal(p.matches('image/png', 'a.png'), false);
});

test('extracts counts and full text', async () => {
  const p = textPlugin();
  const { metadata, fulltext } = await p.extract(src(Buffer.from('mountain sky\nriver')));
  const byKey = Object.fromEntries(metadata.map((m) => [m.key, m.value]));
  assert.equal(byKey.word_count, 3);
  assert.equal(byKey.line_count, 2);
  assert.equal(fulltext, 'mountain sky\nriver');
});

test('respects maxFulltext option', async () => {
  const p = textPlugin({ maxFulltext: 5 });
  const { fulltext } = await p.extract(src(Buffer.from('abcdefghij')));
  assert.equal(fulltext, 'abcde');
});
