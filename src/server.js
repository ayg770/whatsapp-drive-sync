import path from 'path';
import express from 'express';
import { createSession, getPublicState, syncSession, closeSession } from './sessionManager.js';

export function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve('public')));

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
