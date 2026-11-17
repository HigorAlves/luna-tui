// A real TicketMachine over the test database with only the safety screen wired: what a hold does to the ticket row can be read, and a ticket that is not held would fail loudly on the next dependency.
import type { DataSource } from "typeorm";

import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { type TicketScreen } from "../application/ticket-screen.ts";
import { TicketMachine, type TicketMachineDeps } from "../application/ticket-machine.ts";

export const holding = (verdict: "safe" | "suspicious" | "unsafe" = "suspicious", reasons: string[] = ["addresses_agent"]) => {
  const calls: string[] = [];
  const screen: TicketScreen = {
    screen: async (ticket) => {
      calls.push(`${ticket.title}\n${ticket.description}`);
      return { verdict, reasons: verdict === "safe" ? [] : (reasons as never), hash: `h:${ticket.description}` };
    },
  };
  return { screen, calls };
};

export function screeningMachine(db: DataSource, screen: TicketScreen) {
  const store = new PgTicketStore(db);
  const machine = new TicketMachine({ store, screen, now: () => new Date("2026-11-05T12:00:00Z") } as unknown as TicketMachineDeps);
  return { machine, store };
}
