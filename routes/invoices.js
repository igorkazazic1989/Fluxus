import express from 'express';
import { supabase } from '../lib/db.js';
import { createPaymentLink } from '../lib/stripe.js';
import { sendEmail } from '../lib/email.js';
import { emailDay1 } from '../emails/day1-reminder.js';

export const invoiceRoutes = express.Router();

invoiceRoutes.post('/', async (req, res) => {
  const { userId, senderName, clientName, clientEmail, invoiceNumber, amount, currency = 'USD', dueDate } = req.body;
  if (!clientName || !clientEmail || !amount) return res.status(400).json({ error: 'clientName, clientEmail and amount required' });
  try {
    const { data: invoice, error: dbError } = await supabase.from('invoices').insert({ user_id: userId, sender_name: senderName, client_name: clientName, client_email: clientEmail, invoice_number: invoiceNumber, amount: parseFloat(amount), currency, due_date: dueDate || null, status: 'chasing' }).select().single();
    if (dbError) throw dbError;
    const paymentLink = await createPaymentLink({ invoiceId: invoice.id, clientName, amount: parseFloat(amount), currency, invoiceNumber });
    await supabase.from('invoices').update({ stripe_payment_link: paymentLink }).eq('id', invoice.id);
    const email = emailDay1({ clientName, senderName, invoiceNumber: invoiceNumber || invoice.id.slice(0,8), amount: parseFloat(amount).toFixed(2), currency, dueDate: dueDate || 'As agreed', paymentLink });
    await sendEmail({ to: clientEmail, ...email });
    await supabase.from('invoices').update({ reminder_1_sent_at: new Date().toISOString() }).eq('id', invoice.id);
    return res.status(201).json({ success: true, invoiceId: invoice.id, paymentLink });
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
