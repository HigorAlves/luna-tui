// A fake Slack port and an in-memory SlackStore for tests: every Slack method rejects as
// "unexpected" unless the test gives it an answer, and every call is recorded.
import type { SlackWatch, SlackWatchInput, SlackWatchPatch } from "@hardness/contracts";
import { vi } from "vitest";

import { type Slack, SlackError } from "../application/slack.ts";
import type { SlackMetricRow, SlackStore } from "../application/slack-store.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";

type Methods = { [K in keyof Slack]: Slack[K] };

export type FakeSlack = { [K in keyof Slack]: ReturnType<typeof vi.fn<Methods[K]>> } & {
  /** Every call, as `[method, ...args]`. */
  calls: unknown[][];
};

const METHODS: Array<keyof Slack> = [
  "me",
  "searchMentions",
  "conversations",
  "history",
  "replies",
  "usergroups",
  "userInfo",
  "channelInfo",
  "permalink",
  "postMessage",
  "mark",
  "openDm",
  "openSocket",
];

export function fakeSlack(answers: Partial<{ [K in keyof Slack]: Methods[K] }> = {}): FakeSlack {
  const calls: unknown[][] = [];
  const fake = { calls } as unknown as FakeSlack;
  for (const method of METHODS) {
    const given = answers[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    (fake as unknown as Record<string, unknown>)[method] = vi.fn(async (...args: unknown[]) => {
      calls.push([method, ...args]);
      if (!given) throw new SlackError(`unexpected slack.${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
      return given(...args);
    });
  }
  return fake;
}

/** The store port in memory, with the rows exposed. */
export class MemorySlackStore implements SlackStore {
  readonly rows = new Map<string, SlackItemRow>();
  readonly watchRows: SlackWatch[] = [];
  private nextId = 1;

  async items(doneSince: Date): Promise<SlackItemRow[]> {
    return [...this.rows.values()].filter((r) => !r.doneAt || new Date(r.doneAt) >= doneSince).sort((a, b) => b.ts.localeCompare(a.ts));
  }
  async item(id: string): Promise<SlackItemRow | null> {
    return this.rows.get(id) ?? null;
  }
  async save(rows: SlackItemRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }
  async latestTs(): Promise<string | null> {
    const all = [...this.rows.values()].map((r) => r.slackTs);
    return all.length === 0 ? null : all.sort((a, b) => Number(a) - Number(b)).at(-1)!;
  }
  async metricRows(since: Date): Promise<SlackMetricRow[]> {
    return [...this.rows.values()]
      .filter((r) => new Date(r.arrivedAt) >= since)
      .map((r) => ({ ts: r.ts, arrivedAt: r.arrivedAt, repliedAt: r.repliedAt, priority: r.triage?.priority ?? null, expectsReply: r.triage?.expectsReply ?? false }));
  }
  async watches(): Promise<SlackWatch[]> {
    return structuredClone(this.watchRows);
  }
  async addWatch(input: SlackWatchInput & { label: string; builtin?: boolean }): Promise<SlackWatch> {
    if (this.watchRows.some((w) => w.kind === input.kind && w.value === input.value)) throw new Error("duplicate watch");
    const watch: SlackWatch = {
      id: `00000000-0000-0000-0000-${String(this.nextId++).padStart(12, "0")}`,
      kind: input.kind,
      value: input.value,
      label: input.label,
      channels: input.channels,
      enabled: true,
      builtin: input.builtin ?? false,
      priority: input.priority,
      createdAt: "2026-10-28T00:00:00.000Z",
    };
    this.watchRows.push(watch);
    return structuredClone(watch);
  }
  async patchWatch(id: string, patch: SlackWatchPatch): Promise<SlackWatch | null> {
    const at = this.watchRows.findIndex((w) => w.id === id);
    if (at === -1) return null;
    const next = { ...this.watchRows[at]!, ...(patch.label !== undefined ? { label: patch.label } : {}), ...(patch.channels !== undefined ? { channels: patch.channels } : {}), ...(patch.priority !== undefined ? { priority: patch.priority } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) };
    this.watchRows[at] = next;
    return structuredClone(next);
  }
  async deleteWatch(id: string): Promise<void> {
    const at = this.watchRows.findIndex((w) => w.id === id);
    if (at !== -1) this.watchRows.splice(at, 1);
  }
}
