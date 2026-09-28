import 'dotenv/config';
import { startWhatsApp } from './whatsappListener.js';
import { startServer } from './server.js';

async function main() {
  await startWhatsApp();
  startServer(process.env.PORT || 3000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
