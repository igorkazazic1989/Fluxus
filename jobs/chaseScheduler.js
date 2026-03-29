import dayjs from 'dayjs';
import { supabase } from '../lib/db.js';
import { sendEmail } from '../lib/email.js';
import { sendSMS } from '../lib/sms.js';
import { emailDay1 } from '../emails/day1-reminder.js';
import { emailDay7 } from '../emails/day7-formal.js';
import { emailDay14 } from '../emails/day14-collection.js';

export async function runScheduledChases() {
  const now = dayjs();
  const { data: invoices, error } = await supabase.from('invoices').select('*').eq('status', 'chasing');
  if (error) { console.error('[Scheduler]', error.message); return; }
  console.log(`[Scheduler] Checking ${invoices.length} invoices`);

  for (const inv of invoices) {
    const daysOld = now.diff(dayjs(inv.created_at), 'day');
    console.log(`[Debug] id=${inv.id.slice(0,8)} daysOld=${daysOld} r1=${inv.reminder_1_sent_at} phone=${inv.client_phone}`);
console.log(`[Debug] id=${inv.id.slice(0,8)} daysOld=${daysOld} 
r1=${inv.reminder_1_sent_at} phone=${inv.client_phone}`);
    const daysOverdue = inv.due_date ? Math.max(0, now.diff(dayjs(inv.due_date), 'day')) : daysOld;
    const vars = {
      clientName: inv.client_name, senderName: inv.sender_name || 'Your provider',
      invoiceNumber: inv.invoice_number || inv.id.slice(0,8).toUpperCase(),
      amount: Number(inv.amount).toFixed(2), currency: inv.currency,
      dueDate: inv.due_date ? dayjs(inv.due_date).format('DD MMM YYYY') : 'As agreed',
      paymentLink: inv.stripe_payment_link, daysOverdue,
      referenceNumber: `FLX-${inv.id.slice(0,8).toUpperCase()}-COL`,
    };

    try {
      // DAY 3 — SMS påminnelse
      if (daysOld >= 3 && inv.reminder_1_sent_at && !inv.sms_1_sent_at && inv.client_phone) {
        await sendSMS({
          to: inv.client_phone,
          body: `Hi ${inv.client_name}, invoice ${vars.invoiceNumber} for ${inv.currency} ${vars.amount} from ${vars.senderName} is unpaid. Pay in full: ${inv.stripe_payment_link} Or pay in 3 parts: ${inv.stripe_installment_link}`
        });
        await supabase.from('invoices').update({ sms_1_sent_at: now.toISOString() }).eq('id', inv.id);
        console.log(`[Scheduler] Day 3 SMS sent → ${inv.client_phone}`);
      }

      // DAY 7 — Formal email
      if (daysOld >= 7 && inv.reminder_1_sent_at && !inv.reminder_2_sent_at) {
        await sendEmail({ to: inv.client_email, ...emailDay7(vars) });
        await supabase.from('invoices').update({ reminder_2_sent_at: now.toISOString() }).eq('id', inv.id);
        console.log(`[Scheduler] Day 7 sent → ${inv.client_email}`);
      }

      // DAY 10 — SMS eskalering
      else if (daysOld >= 10 && inv.reminder_2_sent_at && !inv.sms_2_sent_at && inv.client_phone) {
        await sendSMS({
          to: inv.client_phone,
          body: `URGENT: Invoice ${vars.invoiceNumber} (${inv.currency} ${vars.amount}) is overdue. Pay in 4 days or this goes to debt collection. Pay in full: ${inv.stripe_payment_link} Or pay in 3 parts: ${inv.stripe_installment_link}`
        });
        await supabase.from('invoices').update({ sms_2_sent_at: now.toISOString() }).eq('id', inv.id);
        console.log(`[Scheduler] Day 10 SMS sent → ${inv.client_phone}`);
      }

      // DAY 14 — Collection notice email
      else if (daysOld >= 14 && inv.reminder_2_sent_at && !inv.reminder_3_sent_at) {
        await sendEmail({ to: inv.client_email, ...emailDay14(vars) });
        await supabase.from('invoices').update({ reminder_3_sent_at: now.toISOString() }).eq('id', inv.id);
      } else if (daysOld >= 21 && inv.reminder_3_sent_at && !inv.authorization_sent_at) {
        await sendDay21Authorization(inv);
        console.log(`[Scheduler] Day 14 sent → ${inv.client_email}`);
      }

    } catch (err) { console.error(`[Scheduler] Failed ${inv.id}:`, err.message); }
  }
}

async function sendDay21Authorization(invoice) {
  try {
    const { emailDay21 } = await import('../emails/day21-authorization.js');
    const daysOverdue = invoice.due_date ? Math.floor((Date.now() - new Date(invoice.due_date)) / 86400000) : 21;
    const authorizationLink = `https://fluxusrecovery.com/authorize?id=${invoice.id}`;
    const email = emailDay21({
      clientName: invoice.client_name,
      senderName: invoice.sender_name,
      invoiceNumber: invoice.invoice_number,
      amount: invoice.amount,
      currency: invoice.currency || 'USD',
      dueDate: invoice.due_date,
      daysOverdue,
      authorizationLink
    });
    await sendEmail({ to: invoice.user_id, subject: email.subject, html: email.html, text: email.text });
    await supabase.from('invoices').update({ authorization_sent_at: new Date().toISOString() }).eq('id', invoice.id);
    console.log(`[Day21] Authorization email sent for invoice ${invoice.id}`);
  } catch(e) { console.error('[Day21]', e.message); }
}
