// The Datadog inbox's poller: incidents, alerting monitors, Error Tracking issues and clustered
// error logs, folded into fingerprinted items, kept in Postgres and published as one snapshot the
// board reads over HTTP and follows on the event stream. A poll persists and publishes what it
// found at once; the datadog_triage pack runs afterwards, one call at a time, and publishes again
// when its verdicts land. The twin of SlackInbox: same start/stop/pollOnce, same backoff on a
// rate limit, same save-then-publish rule for acting on an item (done, snooze, priority, ticket).
import type { DatadogItem, DatadogItemPatch, DatadogSnapshot, DatadogSource, DatadogSourceState, DatadogTaskInput, DatadogTriage, DatadogTriageRun } from "@hardness/contracts";

import { applyFloor, fromCluster, fromIncident, fromIssue, fromMonitor, merge, splitOf, triageOrder } from "../domain/datadog-item.ts";
import type { TaskRow } from "../domain/task.ts";
import { type Datadog, DatadogError, NoDatadogTokenError } from "./datadog.ts";
import type { DatadogStore } from "./datadog-store.ts";
import type { DatadogTriager } from "./datadog-triage.ts";
import type { NewTask } from "./pipeline.ts";
import { AlreadyTaskError } from "./slack-inbox.ts";
import { TriageRunError } from "./slack-triage.ts";
import { Ticker } from "./ticker.ts";

export { AlreadyTaskError };

/** What the HTTP routes need from the inbox; the real class and a test fake both fit. */
export interface DatadogInboxPort {
  readonly snapshot: DatadogSnapshot;
  /** `force` polls even inside a rate-limit backoff (the board's refresh); scheduled polls wait it out. */
  pollOnce(force?: boolean): Promise<DatadogSnapshot>;
  patch(id: string, patch: DatadogItemPatch): Promise<DatadogItem>;
  toTask(id: string, input: DatadogTaskInput): Promise<TaskRow>;
  triageRuns(since: Date): Promise<DatadogTriageRun[]>;
}

export class NoDatadogItemError extends Error {
  constructor(id: string) {
    super(`no Datadog item ${id}`);
    this.name = "NoDatadogItemError";
  }
}

export interface DatadogInboxOptions {
  datadog: Datadog;
  /** null: agents off, or no credential or runner image; items keep their floor and `triage: null`. */
  triager: DatadogTriager | null;
  store: DatadogStore;
  /** The Datadog query narrowing every source, e.g. `env:prod`; empty for everything. */
  scope: string;
  intervalMs: number;
  /** Called with the new snapshot when its items, sources, error or triaging flag changed. */
  publish: (snapshot: DatadogSnapshot) => void;
  createTask: (input: NewTask) => Promise<TaskRow>;
  /** The task an item became, if it still exists. */
  findTask: (taskId: string) => Promise<TaskRow | null>;
  /** The local path of an `owner/name` repository, or null when it is not known here. */
  resolveRepo: (slug: string) => Promise<string | null>;
  now?: () => Date;
  /** Days to keep datadog_triage_runs rows (`MACHINE_RETENTION_DAYS`); 0 or unset keeps them. */
  retentionDays?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
const FIRST_LOOKBACK_MS = 60 * MINUTE_MS;
const OVERLAP_MS = MINUTE_MS;
/** Done items stay listed (and stored) this long. */
const KEEP_DONE_MS = 30 * DAY_MS;
/** Error-log clusters fetched per poll. */
const TOP_CLUSTERS = 15;
const TICK_MS = MINUTE_MS;
const SOURCES: DatadogSource[] = ["incident", "monitor", "error_tracking", "error_logs"];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const emptySources = (): Record<DatadogSource, DatadogSourceState> => ({
  incident: { ok: true, error: null, count: 0 },
  monitor: { ok: true, error: null, count: 0 },
  error_tracking: { ok: true, error: null, count: 0 },
  error_logs: { ok: true, error: null, count: 0 },
});

export class DatadogInbox implements DatadogInboxPort {
  snapshot: DatadogSnapshot = { items: [], polledAt: null, sources: emptySources(), triaging: false, error: null };
  /** How long until the next poll: the interval, or the backoff after a rate limit. */
  nextDelayMs: number;

  private timer: NodeJS.Timeout | undefined;
  private readonly clock = new Ticker(() => void this.refresh().catch(() => {}), TICK_MS);
  private stopped = false;
  private polling: Promise<DatadogSnapshot> | null = null;
  /** After a rate limit: no scheduled poll before this time; a forced refresh still runs. */
  private backoffUntil = 0;
  /** Where each source's last good poll ended; a failing source keeps its window. */
  private readonly lastTo = new Map<DatadogSource, string>();
  /** Where a failing source's window started, kept until it succeeds so nothing between is skipped. */
  private readonly retryFrom = new Map<DatadogSource, string>();
  private lastStates: Record<DatadogSource, DatadogSourceState> = emptySources();
  private lastError: string | null = null;
  private polledAt: string | null = null;
  private triaging: Promise<void> | null = null;
  private triageAgain = false;
  private warnedNoTriager = false;
  private readonly now: () => Date;

  constructor(private readonly options: DatadogInboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextDelayMs = options.intervalMs;
  }

  /** Polls now, then again after each poll's delay; recomputes snoozes every minute. Never throws. */
  start(): void {
    if (this.timer || this.stopped) return;
    const poll = () => {
      void this.pollOnce()
        .catch((error: unknown) => console.warn("datadog inbox: poll failed", error))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(poll, this.nextDelayMs);
          this.timer.unref();
        });
    };
    poll();
    this.clock.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.clock.stop();
    this.timer = undefined;
  }

  /** One poll; a poll already running is shared rather than doubled. Inside a rate-limit backoff only a forced one runs. */
  pollOnce(force = false): Promise<DatadogSnapshot> {
    if (!force && !this.polling && this.now().getTime() < this.backoffUntil) return Promise.resolve(this.snapshot);
    if (!this.polling) {
      this.polling = this.poll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  /** Resolves once no triage is in flight. Tests wait on it; the poll never does. */
  async idle(): Promise<void> {
    while (this.triaging) await this.triaging;
  }

  private async poll(): Promise<DatadogSnapshot> {
    const { datadog, scope } = this.options;
    const now = this.now();
    const to = now.toISOString();
    const fromOf = (source: DatadogSource) => {
      const last = this.lastTo.get(source);
      const from = new Date(last ? new Date(last).getTime() - OVERLAP_MS : now.getTime() - FIRST_LOOKBACK_MS).toISOString();
      const kept = this.retryFrom.get(source);
      return kept !== undefined && kept < from ? kept : from;
    };
    const windows = new Map(SOURCES.map((source) => [source, fromOf(source)]));
    const query = scope.trim();
    const webUrl = (path: string) => datadog.webUrl(path);
    const calls: Record<DatadogSource, () => Promise<DatadogItem[]>> = {
      incident: async () => (await datadog.incidents()).map((raw) => fromIncident(raw, webUrl)),
      monitor: async () => (await datadog.alertingMonitors(query)).map((raw) => fromMonitor(raw, webUrl)),
      error_tracking: async () => (await datadog.errorTrackingIssues(query, windows.get("error_tracking")!, to)).map((raw) => fromIssue(raw, webUrl)),
      error_logs: async () => (await datadog.errorLogClusters(query, windows.get("error_logs")!, to, TOP_CLUSTERS)).map((raw) => fromCluster(raw, webUrl)),
    };
    const settled = await Promise.allSettled(SOURCES.map((source) => calls[source]()));
    const failures = settled.flatMap((r, i) => (r.status === "rejected" ? [{ source: SOURCES[i]!, reason: r.reason as unknown }] : []));

    const states = emptySources();
    const fresh: DatadogItem[] = [];
    settled.forEach((result, i) => {
      const source = SOURCES[i]!;
      if (result.status === "fulfilled") {
        fresh.push(...result.value);
        this.lastTo.set(source, to);
        this.retryFrom.delete(source);
      } else {
        if (!this.retryFrom.has(source)) this.retryFrom.set(source, windows.get(source)!);
        states[source] = { ok: false, error: messageOf(result.reason), count: 0 };
      }
    });
    this.lastStates = states;
    this.polledAt = to;

    let error: string | null = null;
    if (failures.some((f) => f.reason instanceof NoDatadogTokenError)) error = "no_token";
    else if (failures.length === SOURCES.length) error = messageOf(failures[0]!.reason);
    for (const f of failures) {
      if (f.reason instanceof DatadogError && f.reason.status === 429) {
        this.nextDelayMs = RATE_LIMIT_BACKOFF_MS;
        this.backoffUntil = now.getTime() + RATE_LIMIT_BACKOFF_MS;
      }
      if (!(f.reason instanceof NoDatadogTokenError)) console.warn(`datadog inbox: ${f.source}: ${messageOf(f.reason)}`);
    }
    if (!failures.some((f) => f.reason instanceof DatadogError && f.reason.status === 429)) this.nextDelayMs = this.options.intervalMs;
    this.lastError = error;

    if (error === "no_token") {
      this.snapshot = { ...this.snapshot, items: [] };
      return this.refresh(true);
    }
    try {
      const stored = new Map((await this.options.store.items(new Date(now.getTime() - KEEP_DONE_MS))).map((i) => [i.id, i]));
      const merged = new Map<string, DatadogItem>();
      for (const item of fresh) {
        const before = stored.get(item.id);
        merged.set(item.id, before ? merge(before, item, now) : item);
      }
      if (merged.size > 0) await this.options.store.save([...merged.values()]);
      await this.prune();
    } catch (thrown) {
      this.lastError = messageOf(thrown);
      console.warn(`datadog inbox: ${this.lastError}`);
    }
    const snapshot = await this.refresh();
    this.kickTriage();
    return snapshot;
  }

  /** Done items past the 30 days the snapshot shows go, and triage runs past the retention window. */
  private async prune(): Promise<void> {
    const now = this.now().getTime();
    const days = this.options.retentionDays ?? 0;
    const { items, runs } = await this.options.store.prune(new Date(now - KEEP_DONE_MS), days > 0 ? new Date(now - days * DAY_MS) : null);
    if (items > 0 || runs > 0) console.log(`datadog inbox: pruned ${items} done item(s), ${runs} old triage run(s)`);
  }

  /** Rebuilds the snapshot from the store and publishes it when it changed. `empty` skips the store (no keys). */
  private async refresh(empty = false): Promise<DatadogSnapshot> {
    const now = this.now();
    const rows = empty ? [] : await this.options.store.items(new Date(now.getTime() - KEEP_DONE_MS));
    const items = triageOrder(rows.map((row) => ({ ...row, split: splitOf(row, now) })));
    const sources = emptySources();
    for (const source of SOURCES) sources[source] = { ...this.lastStates[source], count: items.filter((i) => i.source === source).length };
    this.publishIfChanged({ items, polledAt: this.polledAt, sources, triaging: this.triaging !== null, error: this.lastError });
    return this.snapshot;
  }

  /** The one place the snapshot is replaced: the board hears about it only when something it shows changed. */
  private publishIfChanged(next: DatadogSnapshot): void {
    const changed = JSON.stringify({ ...next, polledAt: null }) !== JSON.stringify({ ...this.snapshot, polledAt: null }) || next.polledAt !== this.snapshot.polledAt;
    this.snapshot = next;
    if (changed) this.options.publish(next);
  }

  /** Starts a triage run when none is in flight; a poll that lands meanwhile asks for another afterwards. */
  private kickTriage(): void {
    if (this.stopped) return;
    if (this.triaging) {
      this.triageAgain = true;
      return;
    }
    if (!this.options.triager) {
      if (!this.warnedNoTriager && this.snapshot.items.some((i) => i.triage === null)) {
        console.warn("datadog inbox: no triager (agents off, or no credential or runner image): items keep their floor");
        this.warnedNoTriager = true;
      }
      return;
    }
    this.triaging = this.triage()
      .catch((error: unknown) => console.warn(`datadog inbox: triage failed: ${messageOf(error)}`))
      .finally(async () => {
        this.triaging = null;
        await this.refresh().catch(() => {});
        if (this.triageAgain) {
          this.triageAgain = false;
          this.kickTriage();
        }
      });
  }

  /** One pack call over the open items without a verdict, incidents first. */
  private async triage(): Promise<void> {
    const { triager, store, scope } = this.options;
    if (!triager) return;
    const now = this.now();
    const rows = await store.items(new Date(now.getTime() - KEEP_DONE_MS));
    const todo = triageOrder(rows.filter((row) => row.triage === null && splitOf(row, now) !== "done" && splitOf(row, now) !== "snoozed"));
    if (todo.length === 0) return;
    await this.refresh();
    let answers: Awaited<ReturnType<DatadogTriager["triage"]>> = new Map();
    try {
      answers = await triager.triage(todo, scope);
    } catch (error) {
      console.warn(`datadog inbox: triage failed: ${messageOf(error)}`);
      if (error instanceof TriageRunError) answers = error.answers;
    }
    const at = this.now();
    const saved: DatadogItem[] = [];
    // The container took a while: re-read each row so the verdict lands on what you did meanwhile.
    for (const asked of todo) {
      const verdict = answers.get(asked.id);
      const row = await store.item(asked.id);
      if (!verdict || !row || row.triage !== null) continue;
      const triage: DatadogTriage = { ...verdict, priority: applyFloor(verdict.priority, row.floor), by: "model", triagedAt: at.toISOString(), overridden: false };
      saved.push({ ...row, triage, split: splitOf({ ...row, triage }, at) });
    }
    if (saved.length > 0) await store.save(saved);
  }

  private async get(id: string): Promise<DatadogItem> {
    const row = await this.options.store.item(id);
    if (!row) throw new NoDatadogItemError(id);
    return row;
  }

  private async saveAndPublish(row: DatadogItem): Promise<DatadogItem> {
    const next = { ...row, split: splitOf(row, this.now()) };
    await this.options.store.save([next]);
    const snapshot = await this.refresh();
    return snapshot.items.find((i) => i.id === next.id) ?? next;
  }

  async patch(id: string, patch: DatadogItemPatch): Promise<DatadogItem> {
    let next = await this.get(id);
    const now = this.now().toISOString();
    if (patch.done === true && !next.doneAt) next = { ...next, doneAt: now, snoozedUntil: null };
    else if (patch.done === false) next = { ...next, doneAt: null, reopenedAt: null };
    if (patch.snoozedUntil !== undefined) next = { ...next, snoozedUntil: patch.snoozedUntil };
    if (patch.priority) {
      const base: DatadogTriage = next.triage ?? { priority: patch.priority, category: "known", summary: next.title.slice(0, 90), why: "set by hand", suspectedCause: null, nextStep: "", refs: [], by: "rule", triagedAt: now, overridden: true };
      next = { ...next, triage: { ...base, priority: patch.priority, overridden: true } };
    }
    return this.saveAndPublish(next);
  }

  async toTask(id: string, input: DatadogTaskInput): Promise<TaskRow> {
    const row = await this.get(id);
    if (row.taskId && (await this.options.findTask(row.taskId))) throw new AlreadyTaskError(id, row.taskId);
    const where = [row.service, row.env].filter((part): part is string => part !== null).join(" · ");
    const description = [
      `From Datadog (${row.source.replace("_", " ")}): ${row.title}`,
      `${where ? `${where} · ` : ""}status ${row.status}${row.severity ? ` · ${row.severity}` : ""}${row.count !== null ? ` · ${row.count} in the window` : ""}`,
      `First seen ${row.firstSeen}, last seen ${row.lastSeen}`,
      ...(row.triage ? ["", `Triage (${row.triage.priority}): ${row.triage.summary}`, row.triage.why, ...(row.triage.suspectedCause ? [`Suspected cause: ${row.triage.suspectedCause}`] : []), `Next: ${row.triage.nextStep}`] : []),
      ...(row.samples.length > 0 ? ["", "Samples:", ...row.samples.map((s) => `> ${s.replace(/\n/g, "\n> ")}`)] : []),
      "",
      row.url,
    ].join("\n");
    const repoPath = input.repoPath !== undefined ? input.repoPath : row.repository ? await this.options.resolveRepo(row.repository) : null;
    const task = await this.options.createTask({
      title: input.title ?? row.title,
      description,
      repoPath,
      source: { kind: "datadog", source: row.source, id: row.id, url: row.url },
    });
    await this.saveAndPublish({ ...row, taskId: task.id });
    return task;
  }

  triageRuns(since: Date): Promise<DatadogTriageRun[]> {
    return this.options.store.triageRuns(since);
  }
}
