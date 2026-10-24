import { expect, test } from "vitest";

import { renderCart } from "../src/cart.ts";

test("an empty cart says so", () => {
  expect(renderCart([])).toBe('<p class="empty">Your cart is empty</p>');
});

test("a cart with items still renders the list", () => {
  expect(renderCart([{ name: "pen", priceCents: 500, qty: 2 }])).toContain("<li>pen x2");
});
