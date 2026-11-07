// What the machine's API does with memory (RFC 0007, "Ask surfaces"): recall for the host MCP server, the
// board's `?` pane (an answer with citations), the memory view (list, forget, adopt) and the Floor's
// status. A thin layer over the `Memory` port: callers here are the operator, so the viewer is
// `{kind: "operator"}`, which sees every dataset of the repository it names (or all of them when it names
// none) and the company folder. Nothing here chooses a dataset; the port applies the visibility rule.
import type {
  MemoryAnswerAnswer,
  MemoryAnswerContext,
  MemoryAskInput,
  MemoryAskResult,
  MemoryItem,
  MemoryRecallInput,
  MemoryRecallResult,
  MemoryStatusView,
} from "@hardness/contracts";

import type { MemoryViewer } from "../domain/memory-datasets.ts";
import type { Memory, MemoryListFilter } from "./memory.ts";

/** Memory is off on this machine (no Cognee, `memory: off`, or a failure at boot): the API answers 503. */
export class MemoryOffError extends Error {
  constructor() {
    super("memory is off on this machine: no Cognee, MACHINE_MEMORY=off, or it failed at start-up");
  }
}

/** `?via=cognee` was asked and Cognee has no model to complete a graph answer with. */
export class MemoryNoAnswerError extends Error {}

/** The pack path was asked while agents are off (`MACHINE_AGENTS=off`). */
export class MemoryAgentsOffError extends Error {
  constructor() {
    super("this machine runs no packs: agents are off (MACHINE_AGENTS=off); ask with ?via=cognee, or recall");
  }
}

export class MemoryItemNotFoundError extends Error {}

/** What a forget leaves for a later eval: the item as it was and who forgot it, why. */
export interface ForgetRecord {
  id: string;
  by: string;
  reason: string | null;
  at: string;
  item: { kind: MemoryItem["kind"]; repo: string | null; source: MemoryItem["source"]; trust: MemoryItem["trust"]; status: MemoryItem["status"]; text: string; provenance: MemoryItem["provenance"] };
}

export interface MemoryServiceDeps {
  memory: Memory;
  /** One run of the `memory_answer` pack; absent when agents are off. */
  run?: (context: MemoryAnswerContext) => Promise<MemoryAnswerAnswer>;
  /** A checkout path's repository slug (`repoSlug()`); an argument that already is a slug passes through. */
  slugOf: (repoPath: string) => string;
  /** Records a forget as ground truth. A failure here never undoes the forget. */
  onForgotten?: (record: ForgetRecord) => Promise<void>;
  now?: () => Date;
}

export interface ListQuery {
  repo?: string;
  status?: MemoryItem["status"][];
  trust?: MemoryItem["trust"][];
  kinds?: MemoryItem["kind"][];
  limit?: number;
  offset?: number;
}

export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;
const NOTHING = "Memory holds nothing about that.";

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  private get memory(): Memory {
    if (!this.deps.memory.enabled) throw new MemoryOffError();
    return this.deps.memory;
  }

  /** `repo` as the machine names a repository: a checkout path becomes its slug, a slug stays. */
  repoOf(repo: string | undefined): string | null {
    if (repo === undefined || repo === "") return null;
    return repo.startsWith("/") || repo.startsWith("~") ? this.deps.slugOf(repo) : repo;
  }

  private viewer(repo: string | undefined): MemoryViewer {
    return { kind: "operator", repo: this.repoOf(repo) };
  }

  /** Whether memory is on and what it spent today, for the Floor. Never throws; off is `enabled: false`. */
  async status(): Promise<MemoryStatusView> {
    const m = this.deps.memory;
    if (!m.enabled) return { enabled: false, mode: null, tokensToday: null, costUsdToday: null, cognifiedToday: 0 };
    const usage = await m.usage().catch(() => null);
    return { enabled: true, mode: m.mode, tokensToday: usage?.tokensToday ?? null, costUsdToday: usage?.costUsdToday ?? null, cognifiedToday: usage?.cognifiedToday ?? 0 };
  }

  /** Items, never an answer: what the host MCP server's `recall` tool hands a Claude Code session. `includeOutside` stays off: an upload nobody adopted is not recalled. */
  async recall(input: MemoryRecallInput): Promise<MemoryRecallResult> {
    const result = await this.memory.recall({ query: input.query, viewer: this.viewer(input.repo), scope: input.scope ?? "memory" });
    return { items: result.items, note: result.note };
  }

  /** An answer with citations. Default: the `memory_answer` pack over the items recall gave (everything the operator may see). `cognee`: the graph completion. Same shape. */
  async ask(input: MemoryAskInput, via: "pack" | "cognee" = "pack"): Promise<MemoryAskResult> {
    const memory = this.memory;
    const viewer = this.viewer(input.repo);
    if (via === "cognee") {
      const answer = await memory.answer({ query: input.question, viewer });
      if (!answer) throw new MemoryNoAnswerError("Cognee gave no answer: it has no model to complete a graph answer with, or memory has nothing for this viewer");
      return { via, answer: answer.text, citations: answer.citations, grounded: answer.text.trim() !== "", note: null };
    }
    const recalled = await memory.recall({ query: input.question, viewer, scope: "all" });
    if (recalled.items.length === 0) return { via, answer: NOTHING, citations: [], grounded: false, note: recalled.note };
    if (!this.deps.run) throw new MemoryAgentsOffError();
    const out = await this.deps.run({ question: input.question, items: recalled.items, note: recalled.note });
    const given = new Map(recalled.items.map((i) => [i.id, i]));
    // A citation the pack invented is dropped; one it repeated is kept once.
    const cited = [...new Set(out.citations)].flatMap((id) => {
      const item = given.get(id);
      return item ? [{ kind: item.kind === "doc" ? ("doc" as const) : item.kind === "code" ? ("code" as const) : ("item" as const), ref: id }] : [];
    });
    return { via, answer: out.answer, citations: cited, grounded: out.grounded && cited.length > 0, note: recalled.note };
  }

  async list(query: ListQuery): Promise<MemoryItem[]> {
    const filter: MemoryListFilter = {
      limit: Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
      offset: query.offset ?? 0,
      ...(query.repo !== undefined ? { repo: this.repoOf(query.repo) } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.trust ? { trust: query.trust } : {}),
      ...(query.kinds ? { kinds: query.kinds } : {}),
    };
    return this.memory.list(filter);
  }

  async get(id: string): Promise<MemoryItem> {
    const item = await this.memory.get(id);
    if (!item) throw new MemoryItemNotFoundError(`no memory item ${id}`);
    return item;
  }

  /** Forgets an item and keeps the fact that a person did, with the item as it was, as ground truth. */
  async forget(id: string, by: string, reason?: string): Promise<MemoryItem> {
    const item = { ...(await this.get(id)) };
    if (!(await this.memory.forget(id, by, reason))) throw new MemoryItemNotFoundError(`no memory item ${id}`);
    const record: ForgetRecord = {
      id,
      by,
      reason: reason ?? null,
      at: (this.deps.now ?? (() => new Date()))().toISOString(),
      item: { kind: item.kind, repo: item.repo, source: item.source, trust: item.trust, status: item.status, text: item.text, provenance: item.provenance },
    };
    await this.deps.onForgotten?.(record).catch((error) => console.error(`memory: could not record the forget of ${id}:`, error));
    return (await this.memory.get(id)) ?? { ...item, status: "retired" };
  }

  /** A person takes an `outside` item as theirs: it becomes a lesson. */
  async adopt(id: string, by: string): Promise<MemoryItem> {
    await this.get(id);
    if (!(await this.memory.adopt(id, by))) throw new MemoryItemNotFoundError(`item ${id} is not an outside item to adopt`);
    return this.get(id);
  }
}
