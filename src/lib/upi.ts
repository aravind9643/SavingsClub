/**
 * A UPI payment link (NPCI "upi://pay"), which every Indian UPI app opens with
 * the payee, amount and note already filled in. No payment gateway, no fees:
 * the app never touches the money, it only saves the member typing.
 *
 *   pa  payee address (the group's VPA)     pn  payee name
 *   am  amount in rupees, two decimals       cu  currency, always INR
 *   tn  note the payee sees on the credit
 *
 * The amount comes from integer paise and is formatted by splitting the
 * integer -- never paise / 100, which is a float.
 */
export function upiLink(vpa: string, payee: string, amountPaise: number, note: string): string {
  const p = Math.max(0, Math.trunc(amountPaise));
  const am = `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
  const q = new URLSearchParams({ pa: vpa, pn: payee, am, cu: 'INR', tn: note.slice(0, 50) });
  // URLSearchParams writes spaces as '+'; UPI apps expect %20.
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** A UTR is 12 digits; some apps show a longer alphanumeric UPI ref. */
export function looksLikeUpiRef(ref: string): boolean {
  return /^[A-Za-z0-9]{10,35}$/.test(ref.trim());
}
