// The manager's drafts (RFC 0008): each page an agent writes waits for the person, one JSON file per draft under
// `<stateDir>/compliance/drafts/`, owner-only, written atomically (temp file, then rename). The lifecycle is the
// ticket drafts' (waiting, edited, ignored, posting, posted); every tap names the hash of the text shown, so a draft
// that changed under the person never posts. A text that carries a token-shaped string is refused, the machine's or
// the person's. Pages are multi-line markdown, so they do not go through `postable()`, which flattens to one line.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ComplianceDraft, type ComplianceDraftKind, type ComplianceTarget } from "@hardness/contracts";

import { carriesSecret } from "../domain/postable.ts";
import type { Tap } from "./slack-send.ts";
import type { Wiki } from "./wiki.ts";

export const COMPLIANCE_DIR = "compliance";
const DRAFTS_DIR = "drafts";

/** What a tap names: the first 16 hex digits of the sha256 of the shown text (the scheme of `draftHash` in ticket-drafts.ts). */
export const complianceHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export class StaleDraftError extends Error {
  constructor(id: string) {
    super(`the draft ${id} changed since it was shown`);
    this.name = "StaleDraftError";
  }
}

export class DraftNotFoundError extends Error {
  constructor(id: string) {
    super(`no draft ${id}`);
    this.name = "DraftNotFoundError";
  }
}

export class DraftStatusError extends Error {
  constructor(id: string, status: string) {
    super(`the draft ${id} is ${status}`);
    this.name = "DraftStatusError";
  }
}

export class DraftRefusedError extends Error {
  constructor() {
    super("the text carries a token-shaped string, so it is not kept");
    this.name = "DraftRefusedError";
  }
}

/** What opens or refreshes a draft: everything but the lifecycle. */
export type OpenFields = Pick<ComplianceDraft, "id" | "kind" | "repo" | "title" | "period" | "summary" | "text" | "targets">;

export interface ComplianceDraftsOptions {
  stateDir: string;
  now?: () => Date;
}

/** A draft id has `:` and `/` in it, so the file name is its safe characters and a short hash of the whole id. */
const fileNameOf = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}.json`;

export class ComplianceDrafts {
  private readonly dir: string;
  private readonly now: () => Date;
  /** Every change goes through one queue, so two approves of one draft never both claim it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ComplianceDraftsOptions) {
    this.dir = join(options.stateDir, COMPLIANCE_DIR, DRAFTS_DIR);
    this.now = options.now ?? (() => new Date());
  }

  /** Newest first (by when it was last changed). A damaged file is skipped with a warning. */
  async list(): Promise<ComplianceDraft[]> {
    const drafts: ComplianceDraft[] = [];
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const draft = await this.load(join(this.dir, name));
      if (draft) drafts.push(draft);
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ComplianceDraft | null> {
    return this.load(join(this.dir, fileNameOf(id)), true);
  }

  /** A new id is `waiting`. A re-run replaces the text and `original` and goes back to `waiting`, history kept; a posted (or posting) draft is left as it is. */
  open(fields: OpenFields): Promise<ComplianceDraft> {
    return this.serial(async () => {
      if (carriesSecret(fields.text)) throw new DraftRefusedError();
      const at = this.now().toISOString();
      const held = await this.get(fields.id);
      if (held && (held.status === "posted" || held.status === "posting")) return held;
      const { original: _original, error: _error, ...rest } = held ?? {};
      return this.save({ ...rest, ...fields, status: "waiting", hash: complianceHash(fields.text), history: held?.history ?? [], createdAt: held?.createdAt ?? at, updatedAt: at });
    });
  }

  /** The person's text in place of the machine's, the machine's kept. */
  edit(id: string, hash: string, text: string, from: string): Promise<ComplianceDraft> {
    return this.serial(async () => {
      const draft = await this.tappable(id, hash);
      if (carriesSecret(text)) throw new DraftRefusedError();
      const at = this.now().toISOString();
      const { error: _error, ...rest } = draft;
      return this.save({ ...rest, status: "edited", text, original: draft.original ?? draft.text, hash: complianceHash(text), history: [...draft.history, { at, did: "edited", from }], updatedAt: at });
    });
  }

  ignore(id: string, hash: string, from: string): Promise<ComplianceDraft> {
    return this.serial(async () => {
      const draft = await this.tappable(id, hash);
      const at = this.now().toISOString();
      return this.save({ ...draft, status: "ignored", history: [...draft.history, { at, did: "ignored", from }], updatedAt: at });
    });
  }

  /** `posting`: this approve holds the draft until `finish` or `fail`. */
  claim(id: string, hash: string): Promise<ComplianceDraft> {
    return this.serial(async () => {
      const draft = await this.tappable(id, hash);
      return this.save({ ...draft, status: "posting", updatedAt: this.now().toISOString() });
    });
  }

  finish(id: string, from: string): Promise<ComplianceDraft> {
    return this.serial(async () => {
      const draft = await this.posting(id);
      const at = this.now().toISOString();
      const { error: _error, ...rest } = draft;
      return this.save({ ...rest, status: "posted", history: [...draft.history, { at, did: "posted", from }], updatedAt: at });
    });
  }

  /** Back to waiting (edited when the person edited it), with the target's words on `error`. */
  fail(id: string, error: string): Promise<ComplianceDraft> {
    return this.serial(async () => {
      const draft = await this.posting(id);
      const at = this.now().toISOString();
      return this.save({ ...draft, status: draft.original === undefined ? "waiting" : "edited", error, history: [...draft.history, { at, did: "failed", from: "machine" }], updatedAt: at });
    });
  }

  /** At boot: a draft a crash left in `posting` goes back to where it was (a restart is a failed approve); how many were put back. */
  async recoverPosting(): Promise<number> {
    const stuck = (await this.list()).filter((d) => d.status === "posting");
    for (const { id } of stuck) await this.fail(id, "interrupted by a restart");
    return stuck.length;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async existing(id: string, hash: string): Promise<ComplianceDraft> {
    const draft = await this.get(id);
    if (!draft) throw new DraftNotFoundError(id);
    if (draft.hash !== hash) throw new StaleDraftError(id);
    return draft;
  }

  private async tappable(id: string, hash: string): Promise<ComplianceDraft> {
    const draft = await this.existing(id, hash);
    if (draft.status !== "waiting" && draft.status !== "edited") throw new DraftStatusError(id, draft.status);
    return draft;
  }

  private async posting(id: string): Promise<ComplianceDraft> {
    const draft = await this.get(id);
    if (!draft) throw new DraftNotFoundError(id);
    if (draft.status !== "posting") throw new DraftStatusError(id, draft.status);
    return draft;
  }

  private async load(path: string, quiet = false): Promise<ComplianceDraft | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      return ComplianceDraft.parse(JSON.parse(text));
    } catch {
      if (!quiet) console.warn(`compliance drafts: skipping the damaged file ${path}`);
      return null;
    }
  }

  private async save(draft: ComplianceDraft): Promise<ComplianceDraft> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, fileNameOf(draft.id));
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return draft;
  }
}

/** Writes one target of an approved draft. A writer throws with the target's own words when it cannot. */
/** `tap` is the person's approve, for a writer that posts as them (Slack); null when the approve came from no tap. */
export type TargetWriter<K extends ComplianceTarget["kind"]> = (draft: ComplianceDraft, target: Extract<ComplianceTarget, { kind: K }>, tap?: Tap | null) => Promise<void>;
/** The writers beside the built-in `wiki` one: each wave registers the targets it adds. */
export type TargetWriters = { [K in ComplianceTarget["kind"]]?: TargetWriter<K> };

const SUBJECT: Record<ComplianceDraftKind, string> = {
  change_evidence: "Change management evidence",
  questionnaire: "Questionnaire answers",
  access_review: "Access review",
  postmortem: "Postmortem",
  status_report: "Status report",
  release_notes: "Release notes",
};

/** The wiki commit message of a draft: its kind, then its period or title. */
export const commitMessage = (draft: Pick<ComplianceDraft, "kind" | "period" | "title">): string => `${SUBJECT[draft.kind]} ${draft.period ?? draft.title}`;

export interface PublisherDeps {
  drafts: ComplianceDrafts;
  wiki: Wiki;
  handlers?: TargetWriters;
}

/** Approve: claim the draft, hand each target to the writer for its kind in order, mark it posted. A target that fails, or has no
 *  writer, puts the draft back with its words on `error`; the caller still answers with the draft. A retry writes every target again,
 *  so each writer must be safe to repeat (a wiki write of unchanged pages makes no commit). */
export function publisher(deps: PublisherDeps) {
  const writers: TargetWriters = {
    wiki: async (draft, target) => void (await deps.wiki.writePages(target.repo, [{ path: target.path, text: draft.text }], commitMessage(draft))),
    ...deps.handlers,
  };
  const write = (draft: ComplianceDraft, target: ComplianceTarget, tap: Tap | null): Promise<void> => {
    const writer = writers[target.kind] as TargetWriter<typeof target.kind> | undefined;
    if (!writer) throw new Error(`no writer for ${target.kind} targets`);
    return writer(draft, target as never, tap);
  };
  return {
    async approve(id: string, hash: string, from: string, tap: Tap | null = null): Promise<ComplianceDraft> {
      const draft = await deps.drafts.claim(id, hash);
      try {
        for (const target of draft.targets) await write(draft, target, tap);
        return await deps.drafts.finish(id, from);
      } catch (error) {
        return deps.drafts.fail(id, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
export type CompliancePublisher = ReturnType<typeof publisher>;
