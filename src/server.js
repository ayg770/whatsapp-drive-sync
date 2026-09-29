import path from 'path';
import express from 'express';
import { createSession, getPublicState, syncSession, closeSession } from './sessionManager.js';
import { getAuthUrl, exchangeCodeForTokens } from './googleAuth.js';

export function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve('public')));

  // One-time setup: visit this while signed in as the school's Google
  // account to let this app create files under that account's own Drive
  // storage (a Service Account has no storage quota of its own).
  app.get('/admin/google-auth/start', (req, res) => {
    try {
      res.redirect(getAuthUrl());
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/admin/google-auth/callback', async (req, res) => {
    try {
      const tokens = await exchangeCodeForTokens(req.query.code);
      if (!tokens.refresh_token) {
        return res
          .status(400)
          .send(
            'Google did not return a refresh token. This usually means access was already granted once before — remove this app\'s access at https://myaccount.google.com/permissions and try /admin/google-auth/start again.'
          );
      }
      res.send(`
        <!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
        <body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 16px;">
          <h2>החיבור לדרייב הצליח</h2>
          <p>העתק את הטקסט הבא, והוסף אותו כמשתנה סביבה חדש בשם <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> ב-Render (או בקובץ ה-.env המקומי), ואז שמור ופרוס מחדש:</p>
          <textarea readonly style="width:100%; height:100px; font-family:monospace; direction:ltr; text-align:left; padding:8px;">${tokens.refresh_token}</textarea>
        </body></html>
      `);
    } catch (err) {
      res.status(500).send('שגיאה: ' + err.message);
    }
  });

  app.post('/api/session', (req, res) => {
    const id = createSession(req.body?.phoneNumber);
    res.json({ sessionId: id });
  });

  app.get('/api/session/:id', (req, res) => {
    const state = getPublicState(req.params.id);
    if (!state) return res.status(404).json({ error: 'Session not found or expired' });
    res.json(state);
  });

  app.post('/api/session/:id/sync', async (req, res) => {
    try {
      const summary = await syncSession(req.params.id, req.body.groupIds);
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/session/:id', (req, res) => {
    closeSession(req.params.id, { logout: true });
    res.json({ ok: true });
  });

  // POST alias of the above: navigator.sendBeacon (used to disconnect when
  // the visitor closes the tab) can only send POST, not DELETE.
  app.post('/api/session/:id/close', (req, res) => {
    closeSession(req.params.id, { logout: true });
    res.json({ ok: true });
  });

  app.listen(port, () => {
    console.log(`\nOpen http://localhost:${port} to link WhatsApp and sync.\n`);
  });
}
