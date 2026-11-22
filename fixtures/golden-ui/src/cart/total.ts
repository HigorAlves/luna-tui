export interface Line {
  priceCents: number;
  qty: number;
}

/** The cart total in cents. */
export function total(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
}
