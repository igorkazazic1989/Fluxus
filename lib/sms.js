import twilio from 'twilio';
import 'dotenv/config';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export async function sendSMS({ to, body }) {
  if (!to) throw new Error('No phone number provided');
  const msg = await client.messages.create({
    body,
    from: process.env.TWILIO_PHONE,
    to,
  });
  console.log(`[SMS] Sent to ${to} — SID: ${msg.sid}`);
  return msg;
}
