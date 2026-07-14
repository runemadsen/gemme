import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetail } from '../src/web/render.js';

const user = { email: 'r@example.com' };

function fileWith({ name, mime, thumbnailType }) {
  return {
    id: 7,
    original_filename: name,
    versions: [
      {
        id: 42,
        is_current: true,
        mime_type: mime,
        thumbnail_type: thumbnailType,
        version_no: 1,
        byte_size: 100,
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ],
  };
}

test('detail preview: web image renders the full download', () => {
  const html = renderDetail({ user, file: fileWith({ name: 'a.jpg', mime: 'image/jpeg' }), metadata: [] });
  assert.match(html, /<img src="\/api\/files\/7\/versions\/42\/download"/);
});

test('detail preview: RAW shows the generated thumbnail, not the raw bytes', () => {
  const file = fileWith({ name: 'DSC001.arw', mime: 'application/octet-stream', thumbnailType: 'image/webp' });
  const html = renderDetail({ user, file, metadata: [] });
  // The preview <img> points at the thumbnail, never at the unrenderable raw bytes.
  assert.match(html, /<img src="\/api\/files\/7\/versions\/42\/thumbnail"/);
  assert.doesNotMatch(html, /<img src="[^"]*\/download"/);
});

test('detail preview: RAW without a thumbnail yet shows no preview image', () => {
  const file = fileWith({ name: 'DSC001.arw', mime: 'application/octet-stream', thumbnailType: null });
  const html = renderDetail({ user, file, metadata: [] });
  assert.doesNotMatch(html, /class="preview"[^>]*>\s*<img/);
});
