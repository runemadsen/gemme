import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseQuery, parseValue, compileQuery, QueryError } from '../src/lib/search/dsl.js';

test('tokenize keeps quoted segments (incl. spaces) intact', () => {
  assert.deepEqual(tokenize('a b "c d" key:"x y"'), ['a', 'b', '"c d"', 'key:"x y"']);
});

test('parseQuery separates field clauses from free text and handles negation', () => {
  const p = parseQuery('mountain type:image -type:pdf width>1920 -sky');
  assert.deepEqual(
    p.text.map((t) => [t.term, t.negate]),
    [['mountain', false], ['sky', true]]
  );
  assert.deepEqual(
    p.clauses.map((c) => [c.key, c.op, c.values[0].text, c.negate]),
    [
      ['type', ':', 'image', false],
      ['type', ':', 'pdf', true],
      ['width', '>', '1920', false],
    ]
  );
});

test('comma value lists parse to multiple values and compile to OR', () => {
  const p = parseQuery('ext=jpg,png');
  assert.deepEqual(p.clauses[0].values.map((v) => v.text), ['jpg', 'png']);

  const { conditions, params } = compileQuery(p);
  assert.equal(conditions.length, 1);
  assert.match(conditions[0], / OR /);
  assert.ok(params.includes('jpg') && params.includes('png'));

  // A quoted value keeps commas literal (single value).
  const q = parseQuery('name="a,b"');
  assert.deepEqual(q.clauses[0].values.map((v) => v.text), ['a,b']);
});

test('parseValue types numbers, dates, units, and text', () => {
  assert.equal(parseValue('1080').kind, 'number');
  assert.equal(parseValue('1080').num, 1080);
  assert.equal(parseValue('2024-01-15').kind, 'date');
  assert.equal(parseValue('10s').num, 10);
  assert.equal(parseValue('5min').num, 300);
  assert.equal(parseValue('1mb').num, 1024 * 1024);
  assert.equal(parseValue('image/png').kind, 'text');
  assert.equal(parseValue('12zz').kind, 'text'); // unknown unit -> text
});

test('compileQuery emits EXISTS for clauses and MATCH for text', () => {
  const { conditions, params } = compileQuery(parseQuery('mountain width>1920'));
  assert.equal(conditions.length, 2);
  assert.ok(conditions.some((c) => c.includes('value_num > ?')));
  assert.ok(conditions.some((c) => c.includes('metadata_fts MATCH ?')));
  assert.ok(params.includes(1920));
});

test('a free-text term matches FTS body OR a filename substring', () => {
  const { conditions, params } = compileQuery(parseQuery('DSC'));
  assert.equal(conditions.length, 1);
  assert.match(conditions[0], /metadata_fts MATCH \?/);
  assert.match(conditions[0], /key = 'filename'/);
  assert.match(conditions[0], /value_text LIKE \? ESCAPE/);
  assert.ok(params.includes('%DSC%'), 'binds a substring LIKE pattern for the filename');
  // negated term wraps the whole OR in NOT(...)
  assert.ok(compileQuery(parseQuery('-DSC')).conditions[0].startsWith('NOT ('));
});

test('negation and != both produce NOT EXISTS', () => {
  assert.ok(compileQuery(parseQuery('-type:pdf')).conditions[0].startsWith('NOT EXISTS'));
  assert.ok(compileQuery(parseQuery('type!=pdf')).conditions[0].startsWith('NOT EXISTS'));
  // double negative cancels
  assert.ok(compileQuery(parseQuery('-type!=pdf')).conditions[0].startsWith('EXISTS'));
});

test('comparison operator on a text value is a QueryError', () => {
  assert.throws(() => compileQuery(parseQuery('type>image')), QueryError);
});

test('empty query compiles to no conditions', () => {
  const { conditions } = compileQuery(parseQuery('   '));
  assert.deepEqual(conditions, []);
});
