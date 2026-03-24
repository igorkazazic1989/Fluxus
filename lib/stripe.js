import Stripe from 'stripe';
import 'dotenv/config';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export async function createPaymentLink({ invoiceId, clientName, amount, currency, invoiceNumber }) {
  const product = await stripe.products.create({
    name: `Invoice ${invoiceNumber || invoiceId}`,
    metadata: { invoice_id: invoiceId }
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(amount * 100),
    currency: currency.toLowerCase(),
  });
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { invoice_id: invoiceId },
  });
  return link.url;
}
export { stripe };
