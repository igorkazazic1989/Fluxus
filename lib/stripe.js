import Stripe from 'stripe';
import 'dotenv/config';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function createPaymentLink({ invoiceId, clientName, amount, currency, invoiceNumber }) {
  const product = await stripe.products.create({
    name: `Invoice ${invoiceNumber || invoiceId}`,
    metadata: { fluxus_invoice_id: invoiceId }
  });

  // Full payment price
  const fullPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round(amount * 100),
    currency: currency.toLowerCase(),
  });

  // Installment price — 1/3 of total
  const installmentPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: Math.round((amount / 3) * 100),
    currency: currency.toLowerCase(),
  });

  // Full payment link
  const fullLink = await stripe.paymentLinks.create({
    line_items: [{ price: fullPrice.id, quantity: 1 }],
    metadata: { fluxus_invoice_id: invoiceId, type: 'full' },
  });

  // Installment link — pay 1/3 now
  const installmentLink = await stripe.paymentLinks.create({
    line_items: [{ price: installmentPrice.id, quantity: 1 }],
    metadata: { fluxus_invoice_id: invoiceId, type: 'installment' },
  });

  return { fullLink: fullLink.url, installmentLink: installmentLink.url };
}

export { stripe };
