// Public programmatic entry point for @archive/server.
export { resolveConfig, parseFlags } from './config.js';
export { openDatabase, openMemoryDatabase } from './db/index.js';
export { migrate } from './db/migrate.js';
export { BlobStore } from './storage/blobs.js';
export { DerivedStore, extForType } from './storage/derived.js';
export { hashPassword, verifyPassword } from './auth/passwords.js';
export { createUser, getUserById, getUserByEmail, authenticateUser, countUsers } from './auth/users.js';
export { createApp, startServer, buildRouter } from './server/index.js';
export { createEventBus, emitChange } from './events/bus.js';
export { PluginRegistry } from './plugins/registry.js';
export { loadPluginRegistry, CONFIG_FILENAME } from './plugins/config.js';
export { ExtractionWorker, runExtraction, runPending, enqueueExtraction } from './worker/index.js';
export { getVersionMetadata } from './metadata/store.js';
export { searchAssets } from './search/search.js';
export { parseQuery, compileQuery, parseValue, tokenize, QueryError } from './search/dsl.js';
