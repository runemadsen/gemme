import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from '../src/prompt.js';

// Drive the prompter with stream stubs so we exercise the real readline glue
// (a fake function can't catch the "resolve('') on close clobbers the answer" bug).
function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => (out += c.toString()));
  const p = createPrompter({ input, output });
  return { p, input, getOutput: () => out };
}

test('ask() returns the typed line (not an empty string)', async () => {
  const { p, input } = harness();
  const pending = p.ask('Email: ');
  input.write('rune@runemadsen.com\n');
  assert.equal(await pending, 'rune@runemadsen.com');
  p.close();
});

test('multiple sequential questions each capture their own answer', async () => {
  const { p, input, getOutput } = harness();
  const emailP = p.ask('Email: ');
  input.write('a@b.com\n');
  assert.equal(await emailP, 'a@b.com');

  const nameP = p.ask('Name: ');
  input.write('Ada\n');
  assert.equal(await nameP, 'Ada');

  assert.match(getOutput(), /Email: /);
  assert.match(getOutput(), /Name: /);
  p.close();
});

test('askHidden() returns the secret without echoing it', async () => {
  const { p, input, getOutput } = harness();
  const pending = p.askHidden('Password: ');
  input.write('hunter2\n');
  assert.equal(await pending, 'hunter2');
  assert.match(getOutput(), /Password: /);
  assert.ok(!getOutput().includes('hunter2'), 'the typed secret is not echoed');
  p.close();
});
