import { Resend } from 'resend';
import 'dotenv/config';
const resend = new Resend(process.env.RESEND_API_KEY);
export async function sendEmail({ to, subject, html, text }) {
  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME} <${process.env.FROM_EMAIL}>`,
    to, subject, html, text,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return data;
}
