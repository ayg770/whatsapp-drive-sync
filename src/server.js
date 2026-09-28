import path from 'path';
import express from 'express';
import { loadGroups, loadCaptured, loadLastSelection } from './store.js';
import { refreshGroups } from './whatsappListener.js';
import { exportSelectedGroups } from './sync.js';

export function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve('public')));

  app.get('/api/groups', (req, res) => {
    const groups = loadGroups();
    const captured = loadCaptured();

    const groupsWithCounts = groups.map((g) => ({
      ...g,
      pendingCount: captured.filter((c) => c.groupId === g.id && !c.exported).length,
    }));

    res.json({
      groups: groupsWithCounts,
      lastSelection: loadLastSelection(),
    });
  });

  app.post('/api/groups/refresh', async (req, res) => {
    try {
      await refreshGroups();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sync', async (req, res) => {
    try {
      const { groupIds } = req.body;
      const result = await exportSelectedGroups(groupIds);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`\nOpen http://localhost:${port} to select groups and sync.\n`);
  });
}
