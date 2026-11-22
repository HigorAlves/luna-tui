// The implementer's side of the writable ui-designer helper (RFC 0013, phase 5). Only the machine can start a
// container, so a delegation is a request file in the checks mailbox and the helper's progress a state file the machine
// keeps there. When the helper has returned, the machine cherry-picks its commits onto the card's branch and hands the
// result back as a bundle; this file fetches it into /work, fast-forwards, and acknowledges. The bundle is untrusted
// input like any other: fetched with fsck on and no hook, and merged only as a fast-forward of the run's own head.
import type { Ledger, LedgerSlice, RunEvent } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POLL_MS = 25;
const SHA = /^[0-9a-f]{40}$/;
const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.bundle$/;
const PICKED_REF = /^refs\/luna\/helper\/[A-Za-z0-9._/-]+-picked$/;
/** Where the picked tip is fetched to, so the fast-forward names a commit and never a branch the bundle chose. */
const PICK_REF = "refs/luna/pick";
const HOLDING = new Set(["running", "returned", "picking", "conflict_rerun"]);
/** Git for a repository the agent wrote in: no hook, no replaced objects, no external helper, no submodule recursion. */
const HARD = ["--no-optional-locks", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "diff.external=", "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never"];

export interface HelperState {
  state: string;
  attempt: number;
  summary?: string;
  /** The picked tip, when the machine writes one with `committed`. */
  commit?: string;
}

export interface HelperToolsOptions {
  /** `/out/checks`. */
  checksDir: string;
  /** The implementer's repository, `/work`. */
  work: string;
  /** The ledger, read at call time (a resumed run replaces it). */
  ledger: () => Ledger;
  persist: () => void;
  emit: (event: RunEvent) => void;
  /** Writes the run's commits as a bundle for the machine (core/bundles.ts). */
  bundleNow: () => void;
  checkWaitMs: number;
}

const gitRaw = (work: string, args: string[]): string => execFileSync("git", ["-C", work, ...HARD, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (work: string, args: string[]): string => gitRaw(work, args).trim();
const failure = (error: unknown): string => {
  const e = error as { stderr?: Buffer | string; message?: string };
  return (String(e.stderr ?? "").trim() || e.message || String(error)).split("\n")[0]!.slice(0, 300);
};

async function awaitJson(path: string, waitMs: number): Promise<Record<string, unknown> | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // half-written: look again
      }
    }
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The ledger a run starts from: a slice the ui-designer holds without being done (a helper of an earlier container, which no one can reattach) goes back to the implementer. */
export function releaseOrphans(ledger: Ledger): Ledger {
  return {
    ...ledger,
    slices: ledger.slices.map((s) =>
      s.owner === "ui-designer" && s.status !== "committed"
        ? { ...s, owner: "implementer" as const, status: "pending" as const, note: `the ui-designer's slice, taken back: its helper did not outlive the earlier run${s.note ? ` (${s.note.slice(0, 200)})` : ""}` }
        : s,
    ),
  };
}

export function helperTools(options: HelperToolsOptions) {
  const nonce = randomBytes(4).toString("hex");
  let sent = 0;
  const slices = (): LedgerSlice[] => options.ledger().slices;
  const stateOf = (slice: number): HelperState | null => {
    try {
      const parsed = JSON.parse(readFileSync(join(options.checksDir, `helper-state-${slice}.json`), "utf8")) as Partial<HelperState> | null;
      if (!parsed || typeof parsed.state !== "string") return null;
      return { state: parsed.state, attempt: Number.isInteger(parsed.attempt) ? Number(parsed.attempt) : 1, ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}), ...(typeof parsed.commit === "string" ? { commit: parsed.commit } : {}) };
    } catch {
      return null;
    }
  };
  /** The tip of a pick merged into /work whose confirmation has not come: finished by `syncPicks` once the machine says committed. */
  const pending = new Map<number, { tip: string; note: string; before: string }>();
  const held = (): LedgerSlice[] => slices().filter((s) => s.owner === "ui-designer" && s.status !== "committed");
  /** A request file `<kind>-<nonce>-<n>.json` and the path its answer is read from. */
  const request = (kind: string, answered: string, body: Record<string, unknown>): { n: number; answer: string } => {
    const n = ++sent;
    mkdirSync(options.checksDir, { recursive: true });
    writeFileSync(join(options.checksDir, `${kind}-${nonce}-${n}.json`), JSON.stringify({ n, ...body }));
    return { n, answer: join(options.checksDir, `${answered}-${nonce}-${n}.json`) };
  };

  /** One round of the handshake for a returned slice: the error text, or null when the slice is picked. */
  const pickOnce = async (slice: LedgerSlice): Promise<{ retry: true } | { error: string } | null> => {
    options.bundleNow();
    let head: string;
    let before: string;
    try {
      head = git(options.work, ["rev-parse", "--verify", "HEAD"]);
      before = head;
    } catch (error) {
      return { error: `cannot read your HEAD: ${failure(error)}` };
    }
    const asked = request("pick-request", "pick-answer", { slice: slice.id, head });
    const answer = await awaitJson(asked.answer, options.checkWaitMs);
    if (!answer) return { error: `the machine has not answered the pick of slice ${slice.id}; call slice_wait again` };
    if (answer.ok !== true) {
      if (answer.retry === true) return { retry: true };
      return { error: typeof answer.error === "string" ? answer.error : `the machine refused the pick of slice ${slice.id}` };
    }
    const { tip, bundle, picked } = answer;
    if (typeof tip !== "string" || !SHA.test(tip) || typeof bundle !== "string" || !BUNDLE_NAME.test(bundle)) return { error: "the machine's pick answer is malformed" };
    const path = join(options.checksDir, bundle);
    try {
      // The bundle holds one ref, the picked one, and no HEAD; it is fetched by that name, never by HEAD.
      const heads = git(options.work, ["bundle", "list-heads", path]).split("\n").filter(Boolean).map((l) => l.split(" "));
      const ref = heads.length === 1 && heads[0]![0] === tip ? heads[0]![1] : undefined;
      if (!ref || !PICKED_REF.test(ref) || ref.includes("..")) return { error: "the pick bundle does not hold exactly the picked tip" };
      git(options.work, ["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", path, `+${ref}:${PICK_REF}`]);
      if (git(options.work, ["rev-parse", "--verify", PICK_REF]) !== tip) return { error: "the pick bundle's tip is not the tip the machine named" };
    } catch (error) {
      return { error: `cannot take the pick bundle: ${failure(error)}` };
    }
    try {
      // A picked file with uncommitted edits would be overwritten or kept by luck: refuse before any merge, naming them.
      const dirty = new Set(gitRaw(options.work, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter((l) => l.length > 3).map((l) => l.slice(3)));
      const touched = gitRaw(options.work, ["diff", "--name-only", "-z", "HEAD", tip]).split("\0").filter(Boolean);
      const clash = touched.filter((f) => dirty.has(f));
      if (clash.length > 0) return { error: `you have uncommitted changes to slice ${slice.id}'s files: ${clash.join(", ")}; git restore them, then call slice_wait` };
      git(options.work, ["merge", "--ff-only", "--quiet", "--no-verify", tip]);
    } catch (error) {
      return { error: `the pick of slice ${slice.id} does not fast-forward your branch: ${failure(error)}; git restore the slice's files, then call slice_wait` };
    }
    const shas = Array.isArray(picked) ? picked.filter((p): p is string => typeof p === "string" && SHA.test(p)) : [];
    const note = `picked by the machine: ${shas.map((s) => s.slice(0, 8)).join(", ") || tip.slice(0, 8)}`;
    return acknowledge(slice, tip, note, before);
  };

  /** Tells the machine the tip is merged and finishes the slice on its word; a refusal takes the merge back. Null: done. */
  const acknowledge = async (slice: LedgerSlice, tip: string, note: string, before: string): Promise<{ error: string } | null> => {
    const ack = request("pick-ack", "pick-done", { slice: slice.id, head: tip });
    const done = await awaitJson(ack.answer, options.checkWaitMs);
    if (!done) {
      pending.set(slice.id, { tip, note, before });
      return { error: `the machine has not confirmed the pick of slice ${slice.id} yet; call slice_wait` };
    }
    if (done.ok !== true) {
      // The machine's branch did not move: take the merge back, so /work holds no commit the machine never recorded.
      try {
        git(options.work, ["reset", "--keep", before]);
      } catch (error) {
        return { error: `the machine could not move the card's branch, and your branch could not be put back: ${failure(error)}` };
      }
      pending.delete(slice.id);
      return { error: typeof done.reason === "string" ? `the machine could not move the card's branch: ${done.reason}` : "the machine could not move the card's branch" };
    }
    finish(slice, tip, note);
    return null;
  };

  const finish = (slice: LedgerSlice, tip: string, note: string): void => {
    pending.delete(slice.id);
    slice.status = "committed";
    slice.commit = tip;
    slice.owner = "ui-designer";
    slice.note = note;
    options.persist();
    options.emit({ kind: "slice.committed", payload: { id: slice.id, title: slice.title, commit: tip } });
  };

  /** A held slice the machine reports committed, whose confirmation this run never saw: done when HEAD holds the picked tip. */
  const settle = (slice: LedgerSlice): string | null => {
    const known = pending.get(slice.id);
    const tip = known?.tip ?? stateOf(slice.id)?.commit;
    if (!tip || !SHA.test(tip)) return `the machine holds slice ${slice.id} as committed, but its tip is unknown here; call slice_list again, or git log to see whether the pick is in your branch`;
    try {
      git(options.work, ["merge-base", "--is-ancestor", tip, "HEAD"]);
    } catch {
      return `the machine holds slice ${slice.id} as committed at ${tip.slice(0, 8)}, which your branch does not contain; do not reset or rewrite your branch, and tell the person`;
    }
    finish(slice, tip, known?.note ?? `picked by the machine: ${tip.slice(0, 8)}`);
    return null;
  };

  /** Picks every returned slice the ui-designer holds. Returns the first error text, or null. */
  const syncPicks = async (): Promise<string | null> => {
    let problem: string | null = null;
    for (const slice of held()) {
      const now = stateOf(slice.id)?.state;
      if (now === "committed") {
        const unsettled = settle(slice);
        if (unsettled && !problem) problem = unsettled;
        continue;
      }
      if (now !== "returned" && now !== "picking") continue;
      // A pick merged here whose confirmation was lost: the ack goes again before anything new is asked.
      const lost = pending.get(slice.id);
      if (lost) {
        const again = await acknowledge(slice, lost.tip, lost.note, lost.before);
        if (again && !problem) problem = again.error;
        continue;
      }
      let outcome = await pickOnce(slice);
      if (outcome && "retry" in outcome) outcome = await pickOnce(slice);
      if (outcome && "retry" in outcome) outcome = { error: `the machine could not pick slice ${slice.id} twice; call slice_wait again` };
      if (outcome && !problem) problem = outcome.error;
    }
    return problem;
  };

  return {
    syncPicks,
    /** The slices a helper is working on or returning: scope cannot be judged while any is out. */
    outstanding: (): number[] => held().filter((s) => HOLDING.has(stateOf(s.id)?.state ?? "running")).map((s) => s.id),
    async delegate({ slice, message }: { slice: number; message?: string | undefined }): Promise<unknown> {
      const row = slices().find((s) => s.id === slice);
      if (!row) return { error: `no slice ${slice}; call slice_list` };
      const asked = request("helper-request", "helper-answer", { slice, message: message ?? "" });
      const answer = await awaitJson(asked.answer, options.checkWaitMs);
      if (!answer) return { ok: false, error: "no one answered; build the slice yourself" };
      if (answer.ok === true) {
        row.owner = "ui-designer";
        options.persist();
      }
      return answer;
    },
    async wait({ slice, waitSeconds = 120 }: { slice: number; waitSeconds?: number | undefined }): Promise<unknown> {
      const row = slices().find((s) => s.id === slice);
      if (!row) return { error: `no slice ${slice}; call slice_list` };
      if (row.owner !== "ui-designer") return { error: `no helper holds slice ${slice}` };
      const until = Date.now() + Math.min(240, Math.max(1, waitSeconds)) * 1000;
      for (;;) {
        const problem = await syncPicks();
        if (problem) return { error: problem };
        const now = stateOf(slice);
        if (row.status === "committed") return { state: "committed", attempt: now?.attempt ?? 1, ...(now?.summary ? { summary: now.summary } : {}) };
        // The helper building again after a conflict is still at work: the wait goes on, as it does for a running one.
        if (now && now.state !== "running" && now.state !== "conflict_rerun") return now;
        if (Date.now() >= until) return { state: now?.state ?? "running", attempt: now?.attempt ?? 1, ...(now?.summary ? { summary: now.summary } : {}) };
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(POLL_MS, until - Date.now()))));
      }
    },
  };
}
