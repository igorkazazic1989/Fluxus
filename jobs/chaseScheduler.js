import dayjs from 'dayjs';
import { supabase } from '../lib/db.js';
import { sendEmail } from '../lib/email.js';
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
      if (daysOld >= 7 && inv.reminder_1_sent_at && !inv.reminder_2_sent_at) {
        await sendEmail({ to: inv.client_email, ...emailDay7(vars) });
        await supabase.from('invoices').update({ reminder_2_sent_at: now.toISOString() }).eq('id', inv.id);
        console.log(`[Scheduler] Day 7 sent → ${inv.client_email}`);
      } else if (daysOld >= 14 && inv.reminder_2_sent_at && !inv.reminder_3_sent_at) {
        await sendEmail({ to: inv.client_email, ...emailDay14(vars) });
        await supabase.from('invoices').update({ reminder_3_sent_at: now.toISOString() }).eq('id', inv.id);
        console.log(`[Scheduler] Day 14 sent → ${inv.client_email}`);
      }
    } catch (err) { console.error(`[Scheduler] Failed ${inv.id}:`, err.message); }
  }
}
