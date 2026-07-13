import { HttpError } from './respond.js';

/**
 * Wrap a handler so it only runs for authenticated users. Since v1 has no
 * fine-grained permissions, being logged in is sufficient for everything.
 */
export function requireAuth(handler) {
  return (req, res, ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Authentication required');
    return handler(req, res, ctx);
  };
}
