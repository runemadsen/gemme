import { sendJson, readJson, HttpError } from '../respond.js';
import { authenticateUser } from '../../auth/users.js';
import {
  createSession,
  deleteSession,
  serializeSessionCookie,
  clearSessionCookie,
} from '../../auth/sessions.js';
import { requireAuth } from '../middleware.js';

export function registerAuthRoutes(router) {
  router.post('/api/login', async (req, res, ctx) => {
    const { email, password } = await readJson(req);
    const user = await authenticateUser(ctx.db, email, password);
    if (!user) throw new HttpError(401, 'Invalid email or password');
    const token = createSession(ctx.db, user.id);
    sendJson(res, 200, { user }, { 'set-cookie': serializeSessionCookie(token, { secure: ctx.secure }) });
  });

  router.post('/api/logout', (req, res, ctx) => {
    if (ctx.sessionToken) deleteSession(ctx.db, ctx.sessionToken);
    sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
  });

  router.get('/api/me', requireAuth((req, res, ctx) => {
    sendJson(res, 200, { user: ctx.user });
  }));
}
