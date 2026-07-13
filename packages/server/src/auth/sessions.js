import crypto from 'node:crypto';

export const SESSION_COOKIE = 'archive_session';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Create a session for a user and return its opaque token.
 * @returns {string} token
 */
export function createSession(db, userId, ttlMs = DEFAULT_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt
  );
  return token;
}

/**
 * Look up the user for a session token, if the session exists and is unexpired.
 * @returns {object|null} public user row
 */
export function getSessionUser(db, token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.email, u.name, u.created_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      )
      .get(token) ?? null
  );
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Remove expired sessions. Safe to call periodically. */
export function pruneExpiredSessions(db) {
  return db
    .prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    .run().changes;
}

// --- cookie helpers ---------------------------------------------------------

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Serialize the session cookie. `secure` should be true behind HTTPS. */
export function serializeSessionCookie(token, { secure = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
