import { BlobStore } from '../storage/blobs.js';
import { DerivedStore } from '../storage/derived.js';
import { runExtraction, DEFAULT_THUMBNAIL_TARGET } from './extract.js';
import { claimNextJob, completeJob, failJob, enqueueExtraction } from './queue.js';

export { enqueueExtraction } from './queue.js';
export { runExtraction } from './extract.js';

/**
 * Process a single claimed job. Sets the version's extraction_status and the
 * job's terminal status. Plugin-level failures are recorded but still count as
 * a completed extraction (partial success); only a hard failure marks 'failed'.
 */
async function processJob(db, ctx, job) {
  try {
    const { pluginErrors } = await runExtraction(db, ctx, job.version_id);
    setVersionStatus(db, job.version_id, 'done');
    completeJob(db, job.id, {
      error: pluginErrors.length ? JSON.stringify(pluginErrors) : null,
    });
  } catch (err) {
    setVersionStatus(db, job.version_id, 'failed');
    failJob(db, job.id, err.message);
  }
}

function setVersionStatus(db, versionId, status) {
  db.prepare('UPDATE versions SET extraction_status = ? WHERE id = ?').run(status, versionId);
}

/**
 * Drain all currently-pending jobs once. Returns the number processed.
 * Deterministic — used directly by tests and on server startup.
 */
export async function runPending(db, ctx) {
  let processed = 0;
  let job;
  while ((job = claimNextJob(db))) {
    await processJob(db, ctx, job);
    // Signal that this version's metadata/thumbnail changed, so open clients
    // re-render (the pending card gains its thumbnail).
    ctx.events?.emit('change', { type: 'extracted', versionId: job.version_id });
    processed++;
  }
  return processed;
}

/**
 * In-process polling worker. Same box, same process. Enqueue-driven work is
 * picked up on the next tick; also drains anything left pending at startup.
 */
export class ExtractionWorker {
  constructor(db, { dataDir, registry, intervalMs = 250, thumbnailTarget = DEFAULT_THUMBNAIL_TARGET, events } = {}) {
    if (!registry) throw new Error('ExtractionWorker requires a plugin registry');
    this.db = db;
    this.ctx = {
      blobStore: new BlobStore(dataDir),
      derivedStore: new DerivedStore(dataDir),
      registry,
      thumbnailTarget,
      events,
    };
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  /** Enqueue extraction for a version (wire this to onVersionCreated). */
  enqueue(versionId) {
    enqueueExtraction(this.db, versionId);
  }

  async tick() {
    if (this.running) return; // avoid overlapping drains
    this.running = true;
    try {
      await runPending(this.db, this.ctx);
    } catch (err) {
      console.error('extraction worker error:', err.message);
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    // Kick once immediately to drain startup backlog.
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
