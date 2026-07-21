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

test('renderDetail shows a format-neutral public-URL note only when public', () => {
  const file = { id: 42, original_filename: 'a.jpg' };
  const priv = renderDetail({ user, file, metadata: [], isPublic: false });
  assert.doesNotMatch(priv, /public-note/);

  const pub = renderDetail({ user, file, metadata: [], isPublic: true });
  assert.match(pub, /class="public-note"/);
  assert.match(pub, /public collection/);
  assert.match(pub, /<code class="url">\/i\/42<\/code>/);
  // Core stays neutral — no format-specific embed markup (that lives in plugins).
  assert.doesNotMatch(pub, /&lt;img/);
});

test('renderDetail injects the plugin publicEmbed below the public URL message', () => {
  const file = { id: 42, original_filename: 'a.jpg' };
  const publicEmbed = '<pre class="snippet">EMBED-HELP</pre>';
  const html = renderDetail({ user, file, metadata: [], isPublic: true, publicEmbed });
  // The embed help appears, and after the /i/:id URL code within the note.
  assert.match(html, /EMBED-HELP/);
  assert.ok(html.indexOf('/i/42</code>') < html.indexOf('EMBED-HELP'));
  // Not rendered for a private file.
  assert.doesNotMatch(renderDetail({ user, file, metadata: [], isPublic: false, publicEmbed }), /EMBED-HELP/);
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
