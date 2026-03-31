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
        const { data: payout } = await supabase.from('user_payout_details').select('escalation_authorized').eq('user_id', inv.user_id).single();
        if (!payout?.escalation_authorized) { console.log(`[Day21] Skipped — user not authorized ${inv.id}`); continue; }
        await sendDay21Authorization(inv);
        console.log(`[Scheduler] Day 21 authorization sent → ${inv.id}`);
      } else if (daysOld >= 23 && inv.authorization_sent_at && !inv.escalation_stopped && !inv.escalated_at) {
        await sendDay23Handover(inv);
        console.log(`[Scheduler] Day 23 handover sent → ${inv.id}`);
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
      stopLink: authorizationLink
    });
    const { data: { user } } = await supabase.auth.admin.getUserById(invoice.user_id);
    const userEmail = user?.email;
    if (!userEmail) { console.error('[Day21] No email found for user', invoice.user_id); return; }
    await sendEmail({ to: userEmail, subject: email.subject, html: email.html, text: email.text });
    await supabase.from('invoices').update({ authorization_sent_at: new Date().toISOString() }).eq('id', invoice.id);
    console.log(`[Day21] Authorization email sent for invoice ${invoice.id}`);
  } catch(e) { console.error('[Day21]', e.message); }
}

async function sendDay23Handover(invoice) {
  try {
    const { data: { user } } = await supabase.auth.admin.getUserById(invoice.user_id);
    const userEmail = user?.email;
    if (!userEmail) { console.error('[Day23] No email found for user', invoice.user_id); return; }
    const invoiceRef = invoice.invoice_number || invoice.id.slice(0,8).toUpperCase();
    const subject = `What happens next — Invoice ${invoiceRef}`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.wrapper{max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden}.header{background:#080b0f;padding:28px 36px}.logo{color:#00e5a0;font-size:18px;font-weight:700;letter-spacing:.15em}.body{padding:36px}p{font-size:15px;color:#4a5568;line-height:1.7;margin:0 0 16px}.inv-box{background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #00e5a0;border-radius:6px;padding:20px;margin:20px 0}.inv-row{display:flex;justify-content:space-between;font-size:14px;padding:5px 0;border-bottom:1px solid #e2e8f0}.inv-row:last-child{border-bottom:none;font-weight:700}.inv-label{color:#718096}.step-box{background:#fff8f0;border:1px solid #fed7aa;border-radius:6px;padding:20px;margin:20px 0}.step{display:flex;gap:12px;margin-bottom:12px}.step-num{background:#ff4d4d;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}.step-text{font-size:14px;color:#4a5568;line-height:1.6}.footer{background:#f8fafc;padding:20px 36px;border-top:1px solid #e2e8f0;font-size:12px;color:#a0aec0}</style></head><body><div class="wrapper"><div class="header"><div class="logo">◈ FLUXUS</div></div><div class="body"><p style="font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#00e5a0">Case update</p><h2 style="font-size:20px;font-weight:700;color:#1a1a2e;margin:0 0 16px">We did everything we could, ${invoice.sender_name}.</h2><p>We sent <strong>5 professional contacts</strong> over 23 days — emails, SMS reminders, and formal legal notices. Unfortunately, <strong>${invoice.client_name}</strong> has not responded or paid.</p><p>This is not uncommon. Here is what you can do next:</p><div class="inv-box"><div class="inv-row"><span class="inv-label">Invoice</span><span>${invoiceRef}</span></div><div class="inv-row"><span class="inv-label">Debtor</span><span>${invoice.client_name}</span></div><div class="inv-row"><span class="inv-label">Amount outstanding</span><span>${invoice.currency} ${Number(invoice.amount).toFixed(2)}</span></div><div class="inv-row"><span class="inv-label">Days overdue</span><span style="color:#c53030;font-weight:700">${daysOverdue} days</span></div></div><div class="step-box"><p style="font-weight:700;color:#1a1a2e;margin:0 0 12px">Your options from here:</p><div class="step"><div class="step-num">1</div><div class="step-text"><strong>Debt collection agency</strong> — We can refer your case to a licensed debt collection agency. They will pursue payment legally on your behalf. Commission: typically 25–35% of recovered amount. Reply to this email to proceed.</div></div><div class="step"><div class="step-num">2</div><div class="step-text"><strong>Small Claims Court</strong> — You can file a claim yourself online. In the UK: <a href="https://www.gov.uk/make-court-claim-for-money">gov.uk/make-court-claim-for-money</a>. In Canada: contact your provincial court. Cost: £30–100. Our documentation is your evidence.</div></div><div class="step"><div class="step-num">3</div><div class="step-text"><strong>Write it off</strong> — If the amount is small or the debtor is insolvent, this may be the most practical option. You can claim it as a bad debt for tax purposes.</div></div></div><p style="font-size:13px;color:#718096">You have a full record of all 5 contacts sent by Fluxus Recovery. This documentation is legally valid and can be used as evidence in court or with a debt collection agency.</p></div><div class="footer">Fluxus Recovery · Case ID: ${invoice.id} · Acting on behalf of ${invoice.sender_name}</div></div></body></html>`;
    await sendEmail({ to: userEmail, subject, html });
    await supabase.from('invoices').update({ escalated_at: new Date().toISOString() }).eq('id', invoice.id);
    console.log(`[Day23] Handover email sent for invoice ${invoice.id}`);
  } catch(e) { console.error('[Day23]', e.message); }
}
