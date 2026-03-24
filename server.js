import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { invoiceRoutes } from './routes/invoices.js';
import { webhookRoutes } from './routes/webhooks.js';
import { resendWebhookRoutes } from './routes/resendWebhook.js';
import { extractRoutes } from './routes/extract.js';
import { runScheduledChases } from './jobs/chaseScheduler.js';

const app = express();
app.use(cors({ origin: '*' }));
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/invoices', invoiceRoutes);
app.use('/api/extract', extractRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/webhooks', resendWebhookRoutes);
app.get('/health', (_, res) => res.json({ status: 'ok' }));

cron.schedule('0 * * * *', () => {
  console.log('[Scheduler] Running chase check...');
  runScheduledChases();
});

app.listen(3000, () => console.log('Fluxus backend running on :3000'));
