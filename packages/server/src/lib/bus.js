import { EventEmitter } from 'node:events';

/**
 * A tiny in-process pub/sub for "the file list may have changed" signals.
 * Write routes and the extraction worker emit `change`; the SSE endpoint
 * (/api/events) forwards those to connected browsers, which re-run their
 * current query. One bus is shared across the server + worker in a run.
 */
export function createEventBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // one listener per open SSE connection
  return bus;
}

/** Emit a change signal. `detail` is JSON-serialized to SSE clients. */
export function emitChange(events, detail = {}) {
  events?.emit('change', detail);
}
