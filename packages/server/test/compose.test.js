import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveState,
  parseQueryString,
  composeQuery,
  stateToUrl,
  normalizeControls,
  DEFAULTS,
} from '../src/lib/search/compose.js';

test('parseQueryString extracts facet commands (: or =) and leaves the rest as text', () => {
  assert.deepEqual(parseQueryString('ext:jpg'), { text: '', filters: { ext: ['jpg'] } });
  assert.deepEqual(parseQueryString('mountains ext:jpg,png type=image'), {
    text: 'mountains',
    filters: { ext: ['jpg', 'png'], type: ['image'] },
  });
});

test('normalizeControls whitelists/clamps and falls back to defaults', () => {
  assert.deepEqual(normalizeControls({ sort: 'name', direction: 'asc', page: '3', perPage: '100' }), {
    sort: 'name',
    direction: 'asc',
    page: 3,
    perPage: 100,
  });
  // perPage accepts any 1..200 (dropdown just offers presets)
  assert.equal(normalizeControls({ perPage: '7' }).perPage, 7);
  assert.equal(normalizeControls({ perPage: '9999' }).perPage, 200);
  // invalid values -> defaults
  assert.deepEqual(normalizeControls({ sort: 'bogus', direction: 'x', page: '0', perPage: 'abc' }), DEFAULTS);
  assert.deepEqual(normalizeControls({}), DEFAULTS);
});

test('resolveState returns filters + normalized controls; reserved params are not facets', () => {
  const s = resolveState(new URLSearchParams('q=trip&ext=jpg&sort=name&direction=asc&page=2&perPage=25'));
  assert.equal(s.text, 'trip');
  assert.deepEqual(s.filters, { ext: ['jpg'] });
  assert.equal(s.sort, 'name');
  assert.equal(s.direction, 'asc');
  assert.equal(s.page, 2);
  assert.equal(s.perPage, 25);
  // `sort`/`page`/... are not treated as facet keys
  assert.ok(!('sort' in s.filters) && !('page' in s.filters));
});

test('stateToUrl serializes only non-default controls', () => {
  assert.equal(stateToUrl({ text: '', filters: { ext: ['jpg'] } }), 'ext=jpg'); // all controls default
  assert.equal(
    stateToUrl({ text: 'x', filters: {}, sort: 'name', direction: 'asc', page: 2, perPage: 100 }),
    'q=x&sort=name&direction=asc&page=2&perPage=100'
  );
  // defaults are omitted
  assert.equal(stateToUrl({ filters: {}, sort: 'date', direction: 'desc', page: 1, perPage: 50 }), '');
});

test('round-trip: state -> URL -> state is stable (incl. controls)', () => {
  const state = { text: 'trip', filters: { ext: ['jpg', 'png'] }, sort: 'name', direction: 'asc', page: 3, perPage: 25 };
  const back = resolveState(new URLSearchParams(stateToUrl(state)));
  assert.equal(back.text, 'trip');
  assert.deepEqual(back.filters, { ext: ['jpg', 'png'] });
  assert.equal(back.sort, 'name');
  assert.equal(back.direction, 'asc');
  assert.equal(back.page, 3);
  assert.equal(back.perPage, 25);
});

test('typed ?q=ext:jpg and ?ext=jpg resolve to the same filters + defaults', () => {
  const a = resolveState(new URLSearchParams('q=ext:jpg'));
  const b = resolveState(new URLSearchParams('ext=jpg'));
  assert.deepEqual(a, b);
});

test('composeQuery renders canonical text + facet clauses', () => {
  assert.equal(composeQuery('mountains', { ext: ['jpg', 'png'] }), 'mountains ext=jpg,png');
  assert.equal(composeQuery('', {}), '');
});
