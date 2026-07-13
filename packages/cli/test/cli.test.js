import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli, resolveCreateUserInputs } from '../src/cli.js';
import { openDatabase, getUserByEmail } from '@archive/server';

test('help command prints usage', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => (chunks.push(s), true);
  try {
    await runCli(['help']);
  } finally {
    process.stdout.write = orig;
  }
  assert.match(chunks.join(''), /Usage:/);
});

test('unknown command rejects', async () => {
  await assert.rejects(() => runCli(['frobnicate']), /Unknown command/);
});

test('init scaffolds a runnable project (package.json scripts + deps + config)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-init-'));
  try {
    await runCli(['init', '--data-dir', dir, '--no-install']);

    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.start, 'archive start --data-dir .');
    assert.equal(pkg.scripts['create-user'], 'archive create-user --data-dir .');
    assert.ok(pkg.dependencies['@archive/cli'], 'depends on the CLI so `archive` is a local bin');
    assert.ok(pkg.dependencies['@archive/plugin-text']);
    assert.ok(pkg.dependencies['@archive/plugin-image']);

    const config = await fsp.readFile(path.join(dir, 'archive.config.js'), 'utf8');
    assert.match(config, /@archive\/plugin-text/);
    assert.match(config, /export default/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('create-user with flags creates a user (non-interactive)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-cli-'));
  try {
    await runCli(['create-user', '--email', 'x@y.com', '--password', 'pw123456', '--data-dir', dir]);
    const db = openDatabase({ dataDir: dir });
    assert.ok(getUserByEmail(db, 'x@y.com'), 'user should be persisted');
    db.close();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// A prompter that fails if any prompt method is invoked.
const throwingPrompter = () => ({
  ask: () => { throw new Error('should not prompt'); },
  askHidden: () => { throw new Error('should not prompt'); },
  close: () => {},
});

test('create-user with --email and --password never prompts, even in a TTY', async () => {
  // Regression: previously prompted for the optional name and hung.
  const inputs = await resolveCreateUserInputs({
    flags: { email: 'rune@runemadsen.com', password: 'pizza247' },
    env: {},
    tty: true,
    makePrompter: throwingPrompter,
  });
  assert.deepEqual(inputs, { email: 'rune@runemadsen.com', name: null, password: 'pizza247' });
});

test('guided mode prompts for missing fields including optional name', async () => {
  const answers = { 'Email: ': 'a@b.com', 'Name (optional): ': 'Ada' };
  let closed = false;
  const inputs = await resolveCreateUserInputs({
    flags: {},
    env: {},
    tty: true,
    makePrompter: () => ({
      ask: async (q) => answers[q] ?? '',
      askHidden: async () => 'secretpw',
      close: () => { closed = true; },
    }),
  });
  assert.deepEqual(inputs, { email: 'a@b.com', name: 'Ada', password: 'secretpw' });
  assert.equal(closed, true, 'the prompter is closed when done');
});

test('non-interactive with no flags does not prompt (returns empty)', async () => {
  const inputs = await resolveCreateUserInputs({
    flags: {},
    env: {},
    tty: false,
    makePrompter: throwingPrompter,
  });
  assert.deepEqual(inputs, { email: '', name: null, password: '' });
});

test('create-user without password rejects clearly (non-interactive)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-cli-'));
  try {
    await assert.rejects(
      () => runCli(['create-user', '--email', 'x@y.com', '--data-dir', dir]),
      /needs an email and password/
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
