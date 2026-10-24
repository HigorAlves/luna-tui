import { type Item, cartTotal, formatPrice, renderCart } from "./cart.ts";

const items: Item[] = [];
const form = document.querySelector<HTMLFormElement>("#add-form")!;
const cart = document.querySelector<HTMLElement>("#cart")!;
const total = document.querySelector<HTMLElement>("#total")!;

function paint(): void {
  cart.innerHTML = renderCart(items);
  total.textContent = `Total: ${formatPrice(cartTotal(items))}`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  items.push({
    name: String(data.get("name")),
    priceCents: Math.round(Number(data.get("price")) * 100),
    qty: Number(data.get("qty")),
  });
  form.reset();
  paint();
});

paint();
