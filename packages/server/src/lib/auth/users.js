import { hashPassword, verifyPassword } from './passwords.js';

const PUBLIC_COLUMNS = 'id, email, name, created_at';

/**
 * Create a user. Email is normalized (trimmed + lowercased) and must be unique.
 * @returns {Promise<{id:number, email:string, name:string|null, created_at:string}>}
 */
export async function createUser(db, { email, name = null, password }) {
  const normEmail = normalizeEmail(email);
  if (!normEmail) throw new Error('Email is required');
  if (!password) throw new Error('Password is required');

  const password_hash = await hashPassword(password);
  try {
    const info = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(normEmail, name, password_hash);
    return getUserById(db, info.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      throw new Error(`A user with email ${normEmail} already exists`);
    }
    throw err;
  }
}

export function getUserById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id) ?? null;
}

export function getUserByEmail(db, email) {
  return (
    db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`)
      .get(normalizeEmail(email)) ?? null
  );
}

/**
 * Verify credentials. Returns the public user on success, null otherwise.
 * @returns {Promise<object|null>}
 */
export async function authenticateUser(db, email, password) {
  const row = db
    .prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .get(normalizeEmail(email));
  if (!row) {
    // Still run a hash to reduce timing signal on unknown emails.
    await verifyPassword(password, 'scrypt$32768$8$1$00$00');
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  return ok ? getUserById(db, row.id) : null;
}

export function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}
