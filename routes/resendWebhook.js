import express from 'express';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

export const resendWebhookRoutes = express.Router();

/**
 * POST /webhooks/resend
 * Resend anropar denna när ett email studsar.
 * Vi markerar fakturan och stoppar framtida emails.
 */
resendWebhookRoutes.post('/resend', async (req, res) => {
  const event = req.body;
  console.log('[Resend Webhook]', event.type, event.data?.email_id);

  if (event.type === 'email.bounced' || event.type === 'email.complained') {
    const toEmail = event.data?.to?.[0];
    if (!toEmail) return res.json({ received: true });

    // Hitta alla aktiva fakturor med denna email
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, user_id, client_name, invoice_number')
      .eq('client_email', toEmail)
      .eq('status', 'chasing');

    for (const inv of invoices || []) {
      // Markera som bounced — stoppar framtida emails
      await supabase.from('invoices').update({
        email_bounced: true,
        email_bounced_at: new Date().toISOString(),
        status: 'failed'
      }).eq('id', inv.id);

      console.log(`[Resend Webhook] Bounce for ${toEmail} — invoice ${inv.id} marked failed`);
    }
  }

  res.json({ received: true });
});
