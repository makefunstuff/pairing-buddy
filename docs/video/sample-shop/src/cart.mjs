// The cart: line items, the subtotal and the discount codes.

export const CODES = {SPRING10: 0.1, VIP20: 0.2};

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function total(items, code) {
  const rate = CODES[code] ?? 0;
  const amount = subtotal(items);
  return Math.round(amount - rate * amount);
}
