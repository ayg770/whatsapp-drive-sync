import 'dotenv/config';
import { startServer } from './server.js';

startServer(process.env.PORT || 3000);
