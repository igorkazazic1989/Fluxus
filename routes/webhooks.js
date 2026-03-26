import express from 'express';
import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

export const webhookRoutes = express.Router();

webhookRoutes.post('/stripe', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const obj = event.data.object;
    const invoiceId = obj.metadata?.invoice_id;
    if (invoiceId) {
      const paid = (obj.amount_received || obj.amount_total || 0) / 100;
      const commission = parseFloat((paid * 0.05).toFixed(2));
      await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), paid_amount: paid, commission }).eq('id', invoiceId);
      console.log(`✅ Invoice ${invoiceId} PAID — ${paid} (commission: ${commission})`);
      await notifyOwnerPaid({ invoiceId, paid, commission });
    }
  }
  res.json({ received: true });
});

async function notifyOwnerPaid({ invoiceId, paid, commission }) {
  try {
    const { data: inv } = await supabase.from('invoices').select('client_name, invoice_number, currency').eq('id', invoiceId).single();
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: 'igorkazazic1989@gmail.com',
        subject: `💰 Invoice PAID — ${inv?.currency || 'USD'} ${paid} from ${inv?.client_name}`,
        text: `Invoice paid!\n\nClient: ${inv?.client_name}\nInvoice: ${inv?.invoice_number}\nAmount paid: ${inv?.currency || 'USD'} ${paid}\n\nYour 5% commission: ${inv?.currency || 'USD'} ${commission}\n\nRemember to send your invoice to the client for ${commission}!`
      })
    });
  } catch(e) { console.error('[notify paid]', e.message); }
}
