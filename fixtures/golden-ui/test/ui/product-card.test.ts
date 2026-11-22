import { expect, test } from "vitest";

import { productCardCss, renderProductCard } from "../../src/ui/ProductCard.ts";

test("the card shows the name and the price", () => {
  const html = renderProductCard({ name: "Pen", priceCents: 500 });
  expect(html).toContain("Pen");
  expect(html).toContain("$5.00");
});

test("the card has a hover and a focus state, drawn with the design's tokens", () => {
  const css = productCardCss();
  expect(css).toMatch(/\.product-card:hover[^}]*var\(--color-primary-hover\)/);
  expect(css).toMatch(/\.product-card:focus-visible[^}]*var\(--focus-ring\)/);
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
