// Public programmatic entry point for @gemme/server.
export { resolveConfig, parseFlags } from './lib/config.js';
export { openDatabase, openMemoryDatabase } from './lib/db/index.js';
export { migrate } from './lib/db/migrate.js';
export { BlobStore } from './lib/storage/blobs.js';
export { DerivedStore, extForType } from './lib/storage/derived.js';
export { hashPassword, verifyPassword } from './lib/auth/passwords.js';
export { createUser, getUserById, getUserByEmail, authenticateUser, countUsers } from './lib/auth/users.js';
export { createApp, startServer, buildRouter } from './server/index.js';
export { createEventBus, emitChange } from './lib/bus.js';
export { PluginRegistry } from './lib/plugins/registry.js';
export { loadPluginRegistry, CONFIG_FILENAME } from './lib/plugins/config.js';
export { ExtractionWorker, runExtraction, runPending, enqueueExtraction } from './worker/index.js';
export { getFileMetadata } from './lib/metadata/store.js';
export { searchFiles, paginatedSearch } from './lib/search/search.js';
export { getFacet, getFacets } from './lib/facets.js';
export { makeSource, specSig, servingFor, makeServingApi, thumbnailFor, getThumbnail } from './lib/serving.js';
export {
  getCollection,
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  addFileToCollection,
  removeFileFromCollection,
  addFilesToCollection,
  removeFilesFromCollection,
  getFileCollectionIds,
  isFilePublic,
} from './lib/collections.js';
export { parseQuery, compileQuery, parseValue, tokenize, QueryError } from './lib/search/dsl.js';
export {
  resolveState,
  parseQueryString,
  composeQuery,
  stateToUrl,
  normalizeControls,
  FACET_KEYS,
  FILTER_KEYS,
  SORT_KEYS,
  PER_PAGE_OPTIONS,
  DEFAULTS,
} from './lib/search/compose.js';
