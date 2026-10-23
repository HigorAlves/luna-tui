export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(1)}`;
}

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}
