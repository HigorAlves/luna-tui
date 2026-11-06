import { createHash } from "node:crypto";

// The drafts that wait for a person, one per thread. Every change happens inside `transaction(thread, ...)`, which holds the thread's lock, so two
// taps, the expiry clock and a new draft never settle the same row twice. Nothing here posts: a tap does, and a draft that went out is kept.
export type DraftKind = "reply" | "questions" | "shipped" | "status";
export type DraftStatus = "waiting" | "sent" | "edited" | "ignored" | "expired" | "superseded" | "posting" | "posted";

export interface DraftRow {
  id: string;
  thread: string;
  channel: string;
  threadTs: string;
  kind: DraftKind;
  status: DraftStatus;
  text: string;
  /** The machine's own text, kept beside a person's edit. */
  original: string | null;
  cardId: string | null;
  private: boolean;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  history: Array<{ at: string; did: string; from?: string }>;
  /** Decision record ids by step (`assess`, `relation`). */
  records: Record<string, string>;
}

export interface DraftTx {
  /** The thread's waiting draft, locked for this transaction. */
  waiting(thread: string): Promise<DraftRow | null>;
  insert(row: DraftRow): Promise<void>;
  update(id: string, patch: Partial<DraftRow>): Promise<void>;
}

export interface DraftStore {
  transaction<T>(thread: string, fn: (tx: DraftTx) => Promise<T>): Promise<T>;
  get(id: string): Promise<DraftRow | null>;
  allWaiting(): Promise<DraftRow[]>;
  /** The thread's draft that a tap has claimed and is posting right now. */
  posting(thread: string): Promise<DraftRow | null>;
  waitingExpiredBy(now: Date): Promise<DraftRow[]>;
  /** The last `n` edited drafts of a channel, newest first, of public or of private conversations. */
  recentEdited(channel: string, isPrivate: boolean, n: number): Promise<DraftRow[]>;
}

export interface DraftInput {
  thread: string;
  channel: string;
  threadTs: string;
  kind: DraftKind;
  text: string;
  cardId: string | null;
  private: boolean;
  records: Record<string, string>;
}

export type Outcome = "sent_as_drafted" | "edited" | "ignored" | "expired";

export class ConversationDrafts {
  constructor(
    private readonly store: DraftStore,
    private readonly options: { expiryHours: (channel: string) => number; now?: () => Date },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** A new waiting draft; the thread's old one, if any, is marked `superseded`. */
  async open(input: DraftInput): Promise<DraftRow> {
    const now = this.now();
    const row: DraftRow = { ...input, id: crypto.randomUUID(), status: "waiting", original: null, createdAt: now, expiresAt: new Date(now.getTime() + this.options.expiryHours(input.channel) * 3_600_000), decidedAt: null, history: [] };
    await this.store.transaction(input.thread, async (tx) => {
      const old = await tx.waiting(input.thread);
      if (old) await tx.update(old.id, { status: "superseded", decidedAt: now, history: [...old.history, { at: now.toISOString(), did: "superseded" }] });
      await tx.insert(row);
    });
    return row;
  }

  waiting(thread: string): Promise<DraftRow | null> {
    return this.store.transaction(thread, (tx) => tx.waiting(thread));
  }

  get(id: string): Promise<DraftRow | null> {
    return this.store.get(id);
  }

  allWaiting(): Promise<DraftRow[]> {
    return this.store.allWaiting();
  }

  /** Whether a tap is posting this thread's draft right now (a second tap must not post it again). */
  async inFlight(thread: string): Promise<boolean> {
    return (await this.store.posting(thread)) !== null;
  }

  /** Marks every waiting draft past its expiry `expired`; answers them. Posts nothing. */
  async expire(now: Date = this.now()): Promise<DraftRow[]> {
    const done: DraftRow[] = [];
    for (const candidate of await this.store.waitingExpiredBy(now)) {
      await this.store.transaction(candidate.thread, async (tx) => {
        const current = await tx.waiting(candidate.thread);
        if (!current || current.id !== candidate.id || current.expiresAt.getTime() > now.getTime()) return;
        await tx.update(current.id, { status: "expired", decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "expired" }] });
        done.push({ ...current, status: "expired", decidedAt: now });
      });
    }
    return done;
  }

  /** The person sent `text` in the thread: the same text is `sent`, another is `edited` with the machine's text kept. Null when no draft waits (or another tap settled it first). */
  async settle(thread: string, text: string): Promise<{ outcome: Outcome; draft: DraftRow } | null> {
    const now = this.now();
    return this.store.transaction(thread, async (tx) => {
      const current = await tx.waiting(thread);
      if (!current) return null;
      const same = text === current.text;
      const patch: Partial<DraftRow> = same
        ? { status: "sent", decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "sent" }] }
        : { status: "edited", text, original: current.text, decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "edited", from: current.text }] };
      await tx.update(current.id, patch);
      return { outcome: same ? ("sent_as_drafted" as const) : ("edited" as const), draft: { ...current, ...patch } as DraftRow };
    });
  }

  /**
   * A tap's claim before Slack is called: the waiting draft becomes `posting`, with the hash of the text the person saw, under the thread's lock.
   * Answers the draft; null when none waits or another tap already holds it, so two taps in flight post once.
   */
  async claim(thread: string, text: string): Promise<DraftRow | null> {
    const now = this.now();
    return this.store.transaction(thread, async (tx) => {
      const current = await tx.waiting(thread);
      if (!current) return null;
      const history = [...current.history, { at: now.toISOString(), did: "posting", hash: createHash("sha256").update(text).digest("hex") }];
      await tx.update(current.id, { status: "posting", history });
      return { ...current, status: "posting" as const, history };
    });
  }

  /** The message went out: the claimed draft is `sent` (the same text) or `edited` (another, the machine's kept). It stays posted whatever fails after. */
  async finish(id: string, text: string): Promise<{ outcome: Outcome; draft: DraftRow } | null> {
    const now = this.now();
    const thread = (await this.store.get(id))?.thread;
    if (!thread) return null;
    return this.store.transaction(thread, async (tx) => {
      const current = await this.store.get(id);
      if (!current || current.status !== "posting") return null;
      const same = text === current.text;
      const patch: Partial<DraftRow> = same
        ? { status: "sent", decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "sent" }] }
        : { status: "edited", text, original: current.text, decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "edited", from: current.text }] };
      await tx.update(id, patch);
      return { outcome: same ? ("sent_as_drafted" as const) : ("edited" as const), draft: { ...current, ...patch } as DraftRow };
    });
  }

  /** The post failed before anything went out: the claim is given back and the draft waits again. */
  async release(id: string): Promise<void> {
    const thread = (await this.store.get(id))?.thread;
    if (!thread) return;
    await this.store.transaction(thread, async (tx) => {
      const current = await this.store.get(id);
      if (current?.status === "posting") await tx.update(id, { status: "waiting", history: [...current.history, { at: this.now().toISOString(), did: "released" }] });
    });
  }

  /** The person ignored the waiting draft: kept, never posted. */
  async ignore(thread: string): Promise<DraftRow | null> {
    const now = this.now();
    return this.store.transaction(thread, async (tx) => {
      const current = await tx.waiting(thread);
      if (!current) return null;
      await tx.update(current.id, { status: "ignored", decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "ignored" }] });
      return { ...current, status: "ignored" as const, decidedAt: now };
    });
  }

  /** The thread moved: the waiting draft is replaced or dropped. */
  async supersede(thread: string): Promise<DraftRow | null> {
    const now = this.now();
    return this.store.transaction(thread, async (tx) => {
      const current = await tx.waiting(thread);
      if (!current) return null;
      await tx.update(current.id, { status: "superseded", decidedAt: now, history: [...current.history, { at: now.toISOString(), did: "superseded" }] });
      return { ...current, status: "superseded" as const, decidedAt: now };
    });
  }

  /** What a person changed in the drafts of this channel: the machine's text and theirs, the last five, never another channel's and never across privacy. */
  async recentEdits(channel: string, isPrivate: boolean): Promise<Array<{ machine: string; person: string }>> {
    return (await this.store.recentEdited(channel, isPrivate, 5)).map((d) => ({ machine: d.original ?? "", person: d.text }));
  }
}

/** For tests and for a machine with no database: the same contract over memory. */
export class MemoryDraftStore implements DraftStore {
  readonly rows: DraftRow[] = [];
  private order = new Map<string, number>();
  private seq = 0;
  private locks = new Map<string, Promise<unknown>>();

  async transaction<T>(thread: string, fn: (tx: DraftTx) => Promise<T>): Promise<T> {
    const previous = this.locks.get(thread) ?? Promise.resolve();
    const run = previous.then(() =>
      fn({
        waiting: async (t) => this.rows.find((r) => r.thread === t && r.status === "waiting") ?? null,
        insert: async (row) => void this.rows.push(row),
        update: async (id, patch) => {
          const row = this.rows.find((r) => r.id === id);
          if (row) {
            Object.assign(row, patch);
            if (patch.status) this.order.set(id, ++this.seq);
          }
        },
      }),
    );
    this.locks.set(thread, run.catch(() => undefined));
    return run;
  }

  async get(id: string): Promise<DraftRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async allWaiting(): Promise<DraftRow[]> {
    return this.rows.filter((r) => r.status === "waiting");
  }

  async posting(thread: string): Promise<DraftRow | null> {
    return this.rows.find((r) => r.thread === thread && r.status === "posting") ?? null;
  }

  async waitingExpiredBy(now: Date): Promise<DraftRow[]> {
    return this.rows.filter((r) => r.status === "waiting" && r.expiresAt.getTime() <= now.getTime());
  }

  async recentEdited(channel: string, isPrivate: boolean, n: number): Promise<DraftRow[]> {
    return this.rows.filter((r) => r.status === "edited" && r.channel === channel && r.private === isPrivate).sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0)).slice(0, n);
  }
}
