import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { invoiceRoutes } from './routes/invoices.js';
import { webhookRoutes } from './routes/webhooks.js';
import { runScheduledChases } from './jobs/chaseScheduler.js';

const app = express();
app.use(cors());
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/invoices', invoiceRoutes);
app.use('/webhooks', webhookRoutes);
app.get('/health', (_, res) => res.json({ status: 'ok' }));

cron.schedule('0 * * * *', () => {
  console.log('[Scheduler] Running chase check...');
  runScheduledChases();
});

app.listen(3000, () => console.log('Fluxus backend running on :3000'));
