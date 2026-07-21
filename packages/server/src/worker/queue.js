/**
 * Durable extraction job queue over the `jobs` table. Idempotent enqueue,
 * atomic claim, and status transitions. Survives restarts.
 */

const EXTRACT = 'extract';

/** Enqueue extraction for a file unless one is already pending/running. */
export function enqueueExtraction(db, fileId) {
  const existing = db
    .prepare("SELECT id FROM jobs WHERE file_id = ? AND kind = ? AND status IN ('pending','running')")
    .get(fileId, EXTRACT);
  if (existing) return existing.id;
  return db
    .prepare('INSERT INTO jobs (file_id, kind, status) VALUES (?, ?, ?)')
    .run(fileId, EXTRACT, 'pending').lastInsertRowid;
}

/** Atomically claim the oldest pending job, marking it running. Null if none. */
export function claimNextJob(db) {
  const job = db
    .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1")
    .get();
  if (!job) return null;
  const info = db
    .prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'"
    )
    .run(job.id);
  // Lost a race with another claimer.
  if (info.changes === 0) return claimNextJob(db);
  return { ...job, status: 'running', attempts: job.attempts + 1 };
}

export function completeJob(db, id, { error = null } = {}) {
  db.prepare(
    "UPDATE jobs SET status = 'done', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(error, id);
}

export function failJob(db, id, message) {
  db.prepare(
    "UPDATE jobs SET status = 'failed', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(String(message), id);
}

export function pendingJobCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = 'pending'").get().c;
}
