import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import * as sessions from './sessionManager.js';
import { getAuthUrl, exchangeCodeForTokens, saveOAuthRefreshToken } from './googleAuth.js';
import { accessMiddleware, readAccessUsers } from './access.js';

export function createApp({ manager = sessions, users = readAccessUsers() } = {}) {
  const app = express();
  const owners = new Map();
  const oauthStates = new Map();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(accessMiddleware(users));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.resolve('public')));
  app.use('/admin', (req, res, next) =>
    req.visitor.admin ? next() : res.status(403).send('Administrator access required')
  );
  app.get('/admin/google-auth/start', (req, res) => {
    try {
      for (const [state, entry] of oauthStates)
        if (entry.expires < Date.now()) oauthStates.delete(state);
      const state = crypto.randomBytes(32).toString('hex');
      oauthStates.set(state, {
        user: req.visitor.name,
        expires: Date.now() + 10 * 60 * 1000
      });
      res.redirect(getAuthUrl(state));
    } catch {
      res.status(503).send('Google OAuth is not configured');
    }
  });
  app.get('/admin/google-auth/callback', async (req, res) => {
    const entry = oauthStates.get(req.query.state);
    oauthStates.delete(req.query.state);
    if (
      !entry ||
      entry.user !== req.visitor.name ||
      entry.expires < Date.now() ||
      typeof req.query.code !== 'string'
    )
      return res.status(400).send('Invalid or expired authorization state');
    try {
      const tokens = await exchangeCodeForTokens(req.query.code);
      if (!tokens.refresh_token)
        return res
          .status(400)
          .send('No refresh token returned. Repeat authorization with consent.');
      saveOAuthRefreshToken(tokens.refresh_token);
      res
        .type('html')
        .send(
          '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><p>החיבור לגוגל נשמר בשרת. אפשר לחזור לאתר.</p></html>'
        );
    } catch {
      res.status(502).send('Google authorization failed');
    }
  });
  app.post('/api/session', (req, res) => {
    // Expired sessions cannot keep consuming the per-user quota.
    for (const id of owners.keys()) if (!manager.getPublicState(id)) owners.delete(id);
    const existing = [...owners.values()].filter((name) => name === req.visitor.name).length;
    if (existing >= 3)
      return res.status(429).json({ error: 'סיים חיבור קיים לפני פתיחת חיבור נוסף.' });
    const phone = req.body?.phoneNumber;
    if (phone && (typeof phone !== 'string' || !/^\+?[0-9]{8,15}$/.test(phone)))
      return res.status(400).json({ error: 'מספר הטלפון אינו תקין.' });
    const id = manager.createSession(phone);
    owners.set(id, req.visitor.name);
    res.json({ sessionId: id });
  });
  app.use('/api/session/:id', (req, res, next) => {
    if (owners.get(req.params.id) !== req.visitor.name || !manager.getPublicState(req.params.id))
      return res.status(404).json({ error: 'Session not found or expired' });
    next();
  });
  app.get('/api/session/:id', (req, res) => res.json(manager.getPublicState(req.params.id)));
  app.post('/api/session/:id/sync', (req, res) => {
    try {
      res
        .status(202)
        .json(manager.syncSession(req.params.id, req.body?.groupIds, req.body?.lookbackDays));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  const close = async (req, res) => {
    try {
      const result = await manager.closeSession(req.params.id, {
        logout: true
      });
      owners.delete(req.params.id);
      res.json({ ok: true, ...result });
    } catch {
      res.status(500).json({ error: 'ניתוק נכשל. נסה שוב.' });
    }
  };
  app.delete('/api/session/:id', close);
  app.post('/api/session/:id/close', close);
  app.use((err, req, res, next) => res.status(400).json({ error: 'Invalid request' }));
  return app;
}
export function startServer(port) {
  const users = readAccessUsers();
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.DATA_DIR || !path.isAbsolute(process.env.DATA_DIR))
  ) {
    throw new Error('Production requires DATA_DIR pointing to a persistent disk');
  }
  const host = users || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  return createApp({ users }).listen(port, host, () =>
    console.log(`Server listening on port ${port}`)
  );
}
