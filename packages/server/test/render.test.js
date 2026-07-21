import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetail, previewHelpers } from '../src/web/render.js';

const user = { email: 'r@example.com' };

test('renderDetail injects the plugin-provided preview HTML verbatim', () => {
  const file = { id: 7, original_filename: 'a.jpg' };
  const preview = '<video data-hls="/api/files/7/hls/master.m3u8"></video>';
  const html = renderDetail({ user, file, metadata: [], preview });
  assert.match(html, /<div class="preview"><video data-hls="\/api\/files\/7\/hls\/master\.m3u8"><\/video><\/div>/);
});

test('renderDetail with no preview renders an empty preview slot (no core format logic)', () => {
  const html = renderDetail({ user, file: { id: 7, original_filename: 'weird.xyz' }, metadata: [] });
  assert.match(html, /<div class="preview"><\/div>/);
});

test('previewHelpers builds safe id-based URLs bound to the plugin', () => {
  const h = previewHelpers({ id: 'video' }, { id: 42 }, { isPublic: true });
  assert.equal(h.isPublic, true);
  assert.equal(h.url.download(), '/api/files/42/download');
  assert.equal(h.url.thumbnail(), '/api/files/42/thumbnail');
  assert.equal(h.url.serve('master.m3u8'), '/api/files/42/master.m3u8');
  assert.equal(h.url.publicServe('master.m3u8'), '/i/42/master.m3u8');
  assert.equal(h.url.publicServe('w=800.webp'), '/i/42/w=800.webp');
  assert.equal(h.url.publicOriginal(), '/i/42');
  assert.equal(h.url.asset('player.js'), '/plugin-assets/video/player.js');
  assert.equal(typeof h.escapeHtml, 'function');
});
