import 'dotenv/config';
import { startServer } from './server.js';
import { closeAllSessions } from './sessionManager.js';

const server = startServer(process.env.PORT || 3000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 12000);
  deadline.unref();
  try {
    await closeAllSessions();
    process.exit(0);
  } catch {
    console.error('Session cleanup did not complete');
    process.exit(1);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
