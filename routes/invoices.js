import express from 'express';
import { supabase } from '../lib/db.js';
import { createPaymentLink } from '../lib/stripe.js';
import { sendEmail } from '../lib/email.js';
import { emailDay1 } from '../emails/day1-reminder.js';

export const invoiceRoutes = express.Router();

invoiceRoutes.post('/', async (req, res) => {
  const { userId, senderName, clientName, clientEmail, clientPhone, invoiceNumber, amount, currency = 'USD', dueDate } = req.body;
  if (!clientName || !clientEmail || !amount) return res.status(400).json({ error: 'clientName, clientEmail and amount required' });
  try {
    // Calculate late fee based on jurisdiction
  function calculateLateFee(amount, currency) {
    if (currency === 'GBP') {
      if (amount < 1000) return 40;
      if (amount < 10000) return 70;
      return 100;
    }
    if (currency === 'CAD') {
      return parseFloat((amount * 0.05).toFixed(2));
    }
    return 0;
  }
  const lateFee = calculateLateFee(parseFloat(amount), currency);
  const totalWithFee = parseFloat(amount) + lateFee;

  const { data: invoice, error: dbError } = await supabase.from('invoices').insert({ user_id: userId, sender_name: senderName, client_name: clientName, client_email: clientEmail, client_phone: clientPhone || null, invoice_number: invoiceNumber, amount: parseFloat(amount), currency, due_date: dueDate || null, status: 'chasing' }).select().single();
    if (dbError) throw dbError;

    const { fullLink, installmentLink } = await createPaymentLink({ invoiceId: invoice.id, clientName, amount: totalWithFee, currency, invoiceNumber });

    await supabase.from('invoices').update({ stripe_payment_link: fullLink, stripe_installment_link: installmentLink, late_fee: lateFee }).eq('id', invoice.id);

    const formattedAmount = totalWithFee.toFixed(2);
    const installmentAmount = (totalWithFee / 3).toFixed(2);
    const originalAmount = parseFloat(amount).toFixed(2);
    const lateFeeRow = lateFee > 0 ? `<div class="inv-row"><span class="inv-label">Late fee (legal)</span><span style="color:#00b37a">+ ${currency} ${lateFee.toFixed(2)}</span></div>` : '';
    const email = emailDay1({ clientName, senderName, invoiceNumber: invoiceNumber || invoice.id.slice(0,8), amount: formattedAmount, originalAmount, lateFeeRow, installmentAmount, currency, dueDate: dueDate || 'As agreed', paymentLink: fullLink, installmentLink });
    await sendEmail({ to: clientEmail, ...email });
    await supabase.from('invoices').update({ reminder_1_sent_at: new Date().toISOString() }).eq('id', invoice.id);
    await notifyOwner({ clientName, invoiceNumber, amount, currency, clientEmail });
    return res.status(201).json({ success: true, invoiceId: invoice.id, paymentLink: fullLink, installmentLink });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

invoiceRoutes.get('/', async (req, res) => {
  const { userId } = req.query;
  const { data, error } = await supabase.from('invoices').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

invoiceRoutes.post('/extract-invoice', async (req, res) => {
  const { base64, mediaType } = req.body;
  if (!base64) return res.status(400).json({ error: 'No file data' });
  try {
    const isPDF = mediaType === 'application/pdf';
    const cb = isPDF
      ? {type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}
      : {type:'image',source:{type:'base64',media_type:mediaType,data:base64}};
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:500,messages:[{role:'user',content:[cb,{type:'text',text:'Extract invoice details. Respond ONLY with valid JSON:\n{"client":"company name","invNum":"invoice number","amount":"total with currency symbol","email":"client email or empty","due":"due date or Not specified","confidence":0-100}'}]}]})
    });
    const d = await r.json();
    const raw = d.content?.[0]?.text || '{}';
    return res.json(JSON.parse(raw.replace(/```json|```/g,'').trim()));
  } catch(err) {
    return res.status(500).json({confidence:0,client:'',invNum:'',amount:'',email:'',due:''});
  }
});

async function notifyOwner({ clientName, invoiceNumber, amount, currency, clientEmail }) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: 'igorkazazic1989@gmail.com',
        subject: `New chase started — ${currency} ${amount} from ${clientName}`,
        text: `New invoice chase started!\n\nClient: ${clientName}\nEmail: ${clientEmail}\nInvoice: ${invoiceNumber}\nAmount: ${currency} ${amount}\n\nView in Supabase or your dashboard.`
      })
    });
  } catch(e) { console.error('[notify owner]', e.message); }
}

invoiceRoutes.post('/:id/authorize', async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('invoices').update({ authorized_at: new Date().toISOString(), status: 'authorized' }).eq('id', id);
    console.log(`[authorize] Invoice ${id} authorized for debt collection`);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

invoiceRoutes.post('/:id/stop-escalation', async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('invoices').update({ escalation_stopped: true, escalation_stopped_at: new Date().toISOString() }).eq('id', id);
    console.log(`[stop-escalation] Invoice ${id} escalation stopped by owner`);
    await notifyOwnerStopped(id);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function notifyOwnerStopped(invoiceId) {
  try {
    const { data: inv } = await supabase.from('invoices').select('client_name, invoice_number, amount, currency').eq('id', invoiceId).single();
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: 'igorkazazic1989@gmail.com',
        subject: `⛔ Escalation stopped — ${inv?.client_name} · ${inv?.currency} ${inv?.amount}`,
        text: `Your client stopped the debt collection escalation.\n\nClient: ${inv?.client_name}\nInvoice: ${inv?.invoice_number}\nAmount: ${inv?.currency} ${inv?.amount}\n\nThis may mean they intend to pay — or they are disputing the invoice. We recommend following up directly.\n\nFluxus Recovery`
      })
    });
  } catch(e) { console.error('[notify stopped]', e.message); }
}
