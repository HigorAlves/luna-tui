import { expect, test } from "vitest";

import { renderCartPanel } from "../../src/ui/CartPanel.ts";

test("an empty cart says so, politely", () => {
  const html = renderCartPanel({ items: [] });
  expect(html).toContain("Your cart is empty");
  expect(html).toContain('role="status"');
});

test("an error is announced and drawn with the error token", () => {
  const html = renderCartPanel({ items: [], error: "We could not load your cart" });
  expect(html).toContain('role="alert"');
  expect(html).toContain("We could not load your cart");
  expect(html).toContain("var(--color-error)");
});
