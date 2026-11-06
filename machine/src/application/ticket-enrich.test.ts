import type { CanonicalTicket } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Candidate } from "../domain/similarity.ts";
import { enrichTicket } from "./ticket-enrich.ts";

const ticket = (over: Partial<CanonicalTicket> = {}): CanonicalTicket => ({
  tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails for EU cards", description: "Refunding an EU card throws in src/refunds/eu.ts", type: "Bug", status: "To Do", priority: "High",
  reporter: { id: "u1", name: "Ana" }, assignee: "bo", labels: [], components: ["payments"], links: { blocks: ["PAY-30"], duplicates: [], epic: "PAY-1" },
  comments: [{ author: "Bo", text: "seen it", at: null }], attachments: [{ name: "log.txt", url: "https://evil.example/x" }], sprint: null, dueAt: null, createdAt: null, updatedAt: null, permalink: "https://x/PAY-12", ...over,
});
const card = (id: string, title: string, text: string): Candidate => ({ id, kind: "open", title, text, repo: null, closedAt: null });
const now = new Date("2026-11-05T12:00:00Z");

describe("enriching a ticket by script and existing ports", () => {
  it("gathers its linked tickets and epic, recent tickets, the code its text points at, and the cards it may duplicate", async () => {
    const locate = vi.fn(async () => ["src/refunds/eu.ts"]);
    const recent = vi.fn(async () => [{ key: "PAY-9", title: "Refund rounding" }]);
    const out = await enrichTicket(ticket(), { locate, recent, candidates: [card("c1", "Refund fails for EU cards", "throws on refunding an EU card"), card("c2", "Dark mode", "colours")] }, now);
    expect(out.linked).toEqual(["PAY-30"]);
    expect(out.epic).toBe("PAY-1");
    expect(out.recent).toEqual([{ key: "PAY-9", title: "Refund rounding" }]);
    expect(out.files).toEqual(["src/refunds/eu.ts"]);
    expect(out.shortlist.map((n) => n.id)).toEqual(["c1"]);
    expect(locate).toHaveBeenCalledWith(expect.stringContaining("Refund fails for EU cards"));
  });

  it("bounds every list and survives a port that fails", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ key: `P-${i}`, title: "t" }));
    const out = await enrichTicket(ticket({ links: { blocks: Array.from({ length: 30 }, (_, i) => `B-${i}`), duplicates: [], epic: null } }), {
      locate: async () => Array.from({ length: 50 }, (_, i) => `f${i}.ts`),
      recent: async () => many,
      candidates: [],
    }, now);
    expect(out.linked.length).toBeLessThanOrEqual(20);
    expect(out.recent.length).toBeLessThanOrEqual(10);
    expect(out.files.length).toBeLessThanOrEqual(10);
    const failing = await enrichTicket(ticket(), { locate: async () => { throw new Error("no graph"); }, recent: async () => { throw new Error("db"); }, candidates: [] }, now);
    expect(failing.files).toEqual([]);
    expect(failing.recent).toEqual([]);
  });

  it("never opens an attachment or any address the ticket names", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await enrichTicket(ticket({ description: "see https://evil.example/steal and /etc/passwd" }), { candidates: [] }, now);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
