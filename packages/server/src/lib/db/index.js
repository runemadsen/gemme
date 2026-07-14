import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrate.js';

/**
 * The single point of access to SQLite. All other modules go through the
 * handle returned here so the underlying driver (node:sqlite today) can be
 * swapped for e.g. better-sqlite3 without touching callers.
 *
 * @param {object} opts
 * @param {string} opts.dataDir - directory that holds gemme.db
 * @param {boolean} [opts.migrate=true] - run pending migrations on open
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase({ dataDir, migrate: runMigrations = true }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'gemme.db');
  const db = new DatabaseSync(dbPath);
  applyPragmas(db);
  if (runMigrations) migrate(db);
  return db;
}

/**
 * Open an in-memory database. Used by tests; migrations run by default.
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openMemoryDatabase({ migrate: runMigrations = true } = {}) {
  const db = new DatabaseSync(':memory:');
  applyPragmas(db);
  if (runMigrations) migrate(db);
  return db;
}

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}
