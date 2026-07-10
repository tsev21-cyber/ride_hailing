const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

let counter = 0;

/** Stripe-shaped opaque identifiers, e.g. pi_3PqL8xA2fR. */
export function sid(prefix: string, len = 14): string {
  counter = (counter + 1) % 1e9;
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return `${prefix}_${out}`;
}

export function seq(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(5, '0')}`;
}
