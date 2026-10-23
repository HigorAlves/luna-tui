export interface Item {
  name: string;
  priceCents: number;
  qty: number;
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The cart total in cents. */
export function cartTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.priceCents, 0);
}

/** The cart as an HTML list. */
export function renderCart(items: Item[]): string {
  const rows = items.map((item) => `<li>${item.name} x${item.qty} - ${formatPrice(item.priceCents * item.qty)}</li>`);
  return `<ul>${rows.join("")}</ul>`;
}
