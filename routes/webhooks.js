import express from 'express';
import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/db.js';
import { sendEmail } from '../lib/email.js';

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
        const installmentNum = !inv?.installment_1_paid_at ? 1 : !inv?.installment_2_paid_at ? 2 : 3;
        const installmentUpdate = {};
        installmentUpdate[`installment_${installmentNum}_paid_at`] = new Date().toISOString();

        await supabase.from('invoices').update({
          paid_amount: totalPaid,
          status: allPaid ? 'paid' : 'partially_paid',
          paid_at: allPaid ? new Date().toISOString() : null,
          commission: allPaid ? parseFloat((totalPaid * 0.05).toFixed(2)) : null,
          ...installmentUpdate
        }).eq('id', invoiceId);

        console.log(`💳 Installment ${invoiceId} — paid so far: ${totalPaid}/${fullAmount} ${allPaid ? '✅ COMPLETE' : '⏳ partial'}`);

        if (allPaid) {
          const commission = parseFloat((totalPaid * 0.05).toFixed(2));
          await notifyOwnerPaid({ invoiceId, paid: totalPaid, commission, isInstallment: true });
        } else {
          await notifyOwnerPartial({ invoiceId, paid, totalPaid, fullAmount });
          const { data: partInv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
          if (partInv?.client_email) {
            await sendEmail({
              to: partInv.client_email,
              subject: `Installment ${installmentNum} received — Invoice ${partInv.invoice_number || invoiceId.slice(0,8).toUpperCase()}`,
              html: `<div style="font-family:sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden"><div style="background:#080b0f;padding:28px 36px"><div style="color:#00e5a0;font-size:18px;font-weight:700;letter-spacing:.15em">◈ FLUXUS</div></div><div style="padding:36px"><h2 style="color:#1a1a2e">Installment ${installmentNum} received ✅</h2><p style="color:#4a5568">Hi ${partInv.client_name},</p><p style="color:#4a5568">We have received installment ${installmentNum} of <strong>${partInv.currency} ${paid.toFixed(2)}</strong> for invoice <strong>${partInv.invoice_number}</strong>.</p><p style="color:#4a5568">Total paid so far: <strong>${partInv.currency} ${totalPaid.toFixed(2)}</strong> of ${partInv.currency} ${fullAmount.toFixed(2)}.</p><p style="color:#718096;font-size:13px">${installmentNum < 3 ? 'Your next installment will be due in 30 days.' : 'All installments complete. Thank you!'}</p></div><div style="background:#f8fafc;padding:20px 36px;border-top:1px solid #e2e8f0;font-size:12px;color:#a0aec0">Fluxus Recovery · Acting on behalf of ${partInv.sender_name}</div></div>`
            });
          }
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
        const { data: paidInv } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
        if (paidInv?.client_email) {
          await sendEmail({
            to: paidInv.client_email,
            subject: `Payment confirmed — Invoice ${paidInv.invoice_number || invoiceId.slice(0,8).toUpperCase()}`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden"><div style="background:#080b0f;padding:28px 36px"><div style="color:#00e5a0;font-size:18px;font-weight:700;letter-spacing:.15em">◈ FLUXUS</div></div><div style="padding:36px"><h2 style="color:#1a1a2e">Payment received ✅</h2><p style="color:#4a5568">Hi ${paidInv.client_name},</p><p style="color:#4a5568">We have received your full payment of <strong>${paidInv.currency} ${paid.toFixed(2)}</strong> for invoice <strong>${paidInv.invoice_number}</strong>. Thank you!</p><p style="color:#718096;font-size:13px">This is your payment confirmation. No further action is required.</p></div><div style="background:#f8fafc;padding:20px 36px;border-top:1px solid #e2e8f0;font-size:12px;color:#a0aec0">Fluxus Recovery · Acting on behalf of ${paidInv.sender_name}</div></div>`
          });
        }
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
