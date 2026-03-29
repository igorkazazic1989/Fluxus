import express from 'express';
import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/db.js';

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
    const invoiceId = obj.metadata?.fluxus_invoice_id || obj.metadata?.invoice_id;
    const type = obj.metadata?.type;

    if (invoiceId) {
      const paid = (obj.amount_received || obj.amount_total || 0) / 100;

      if (type === 'installment') {
        // Installment payment — add to paid_amount, check if all 3 parts done
        const { data: inv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
        const alreadyPaid = parseFloat(inv?.paid_amount || 0);
        const totalPaid = parseFloat((alreadyPaid + paid).toFixed(2));
        const fullAmount = parseFloat(inv?.amount || 0);
        const allPaid = totalPaid >= fullAmount * 0.99;

        await supabase.from('invoices').update({
          paid_amount: totalPaid,
          status: allPaid ? 'paid' : 'chasing',
          paid_at: allPaid ? new Date().toISOString() : null,
          commission: allPaid ? parseFloat((totalPaid * 0.05).toFixed(2)) : null
        }).eq('id', invoiceId);

        console.log(`💳 Installment ${invoiceId} — paid so far: ${totalPaid}/${fullAmount} ${allPaid ? '✅ COMPLETE' : '⏳ partial'}`);

        if (allPaid) {
          const commission = parseFloat((totalPaid * 0.05).toFixed(2));
          await notifyOwnerPaid({ invoiceId, paid: totalPaid, commission, isInstallment: true });
        } else {
          await notifyOwnerPartial({ invoiceId, paid, totalPaid, fullAmount });
        }

      } else {
        // Full payment
        const commission = parseFloat((paid * 0.05).toFixed(2));
        await supabase.from('invoices').update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          paid_amount: paid,
          commission
        }).eq('id', invoiceId);

        console.log(`✅ Invoice ${invoiceId} PAID — ${paid} (commission: ${commission})`);
        await notifyOwnerPaid({ invoiceId, paid, commission, isInstallment: false });
      }
    }
  }

  res.json({ received: true });
});

async function notifyOwnerPaid({ invoiceId, paid, commission, isInstallment }) {
  try {
    const { data: inv } = await supabase.from('invoices').select('client_name, invoice_number, currency').eq('id', invoiceId).single();
    const method = isInstallment ? 'in 3 parts' : 'in full';
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: 'igorkazazic1989@gmail.com',
        subject: `💰 Invoice PAID ${method} — ${inv?.currency || 'USD'} ${paid} from ${inv?.client_name}`,
        text: `Invoice fully paid ${method}!\n\nClient: ${inv?.client_name}\nInvoice: ${inv?.invoice_number}\nTotal paid: ${inv?.currency || 'USD'} ${paid}\n\nYour 5% commission: ${inv?.currency || 'USD'} ${commission}\n\nRemember to send your invoice to the client for ${commission}!`
      })
    });
  } catch(e) { console.error('[notify paid]', e.message); }
}

async function notifyOwnerPartial({ invoiceId, paid, totalPaid, fullAmount }) {
  try {
    const { data: inv } = await supabase.from('invoices').select('client_name, invoice_number, currency').eq('id', invoiceId).single();
    const part = totalPaid >= fullAmount * 0.66 ? 2 : 1;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: 'igorkazazic1989@gmail.com',
        subject: `💳 Installment ${part}/3 received — ${inv?.currency || 'USD'} ${paid} from ${inv?.client_name}`,
        text: `Installment payment received!\n\nClient: ${inv?.client_name}\nInvoice: ${inv?.invoice_number}\nThis payment: ${inv?.currency || 'USD'} ${paid}\nTotal paid so far: ${inv?.currency || 'USD'} ${totalPaid} / ${fullAmount}\n\nWaiting for remaining installments before charging commission.`
      })
    });
  } catch(e) { console.error('[notify partial]', e.message); }
}
