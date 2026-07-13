import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, parseFlags, DEFAULT_PORT } from '../src/config.js';

test('defaults to ~/.archive and default port with no flags or env', () => {
  const cfg = resolveConfig({ argv: [], env: {} });
  assert.equal(cfg.dataDir, path.join(os.homedir(), '.archive'));
  assert.equal(cfg.port, DEFAULT_PORT);
});

test('flags take precedence over env', () => {
  const cfg = resolveConfig({
    argv: ['--port', '8080', '--data-dir', '/tmp/arch'],
    env: { ARCHIVE_PORT: '9999', ARCHIVE_DATA_DIR: '/other' },
  });
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.dataDir, path.resolve('/tmp/arch'));
});

test('env used when flags absent', () => {
  const cfg = resolveConfig({ argv: [], env: { PORT: '5000' } });
  assert.equal(cfg.port, 5000);
});

test('rejects invalid port', () => {
  assert.throws(() => resolveConfig({ argv: ['--port', 'abc'], env: {} }), /Invalid port/);
  assert.throws(() => resolveConfig({ argv: ['--port', '70000'], env: {} }), /Invalid port/);
});

test('parseFlags handles --key=value, --key value, and bare --flag', () => {
  assert.deepEqual(parseFlags(['--a=1', '--b', '2', '--c']), { a: '1', b: '2', c: true });
});
