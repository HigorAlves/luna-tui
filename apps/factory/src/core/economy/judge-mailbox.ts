// The loop guard's judge, over the /out/checks mailbox the luna tools already use: the guard's question is
// a request file the machine's build watch reads; its verdict is an answer file read on a later call. Neither
// side waits for the other: `ask` returns at once and `poll` looks once. It never throws.
// Several containers of one Build stage share the folder, so every file carries this judge's nonce, and a
// judge starts by clearing the loop files an earlier run left: an old answer is never read as a new one.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JudgePort } from "./session.ts";
import type { Verdict } from "./guard.ts";

/** The most a redirect may hold, as the pack's answer allows. */
const REDIRECT_MAX = 1200;
/** How long an answer is waited for: the job timeout upstream gives the judge. */
const ANSWER_TIMEOUT_MS = 300_000;

/** A redirect as one line of at most `REDIRECT_MAX` characters. */
const flatten = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, REDIRECT_MAX);

/** The answer file's body as a verdict, or null when it is not one. The file is the machine's, but /out is writable by the container, so it is read as untrusted. */
function verdictOf(text: string): Verdict | null {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { stuck, confidence, cause, redirect } = body as Record<string, unknown>;
  if (typeof stuck !== "boolean" || typeof confidence !== "number" || !Number.isFinite(confidence) || typeof cause !== "string") return null;
  const note = typeof redirect === "string" ? flatten(redirect) : "";
  return { stuck, confidence: Math.min(1, Math.max(0, confidence)), cause, ...(note ? { redirect: note } : {}) };
}

/** Best effort: the loop request and answer files of earlier runs. */
function clearLoopFiles(checksDir: string): void {
  try {
    for (const name of readdirSync(checksDir)) if (/^loop-(request|answer)-/.test(name)) rmSync(join(checksDir, name), { force: true });
  } catch {
    // No folder yet, or not readable: nothing to clear.
  }
}

/** The judge port over the checks directory, or null when the run has none (the guard then keeps its backstop). `timeoutMs` and `now` are for tests. */
export function mailboxJudge(checksDir: string | undefined, opts: { timeoutMs?: number; now?: () => number } = {}): JudgePort | null {
  if (!checksDir) return null;
  const timeoutMs = opts.timeoutMs ?? ANSWER_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const nonce = randomBytes(4).toString("hex");
  clearLoopFiles(checksDir);
  let asked = 0;
  let read = 0;
  let askedAt = 0;
  return {
    ask(digest) {
      try {
        const n = asked + 1;
        mkdirSync(checksDir, { recursive: true });
        const tmp = join(checksDir, `.loop-request-${nonce}-${n}.json.tmp`);
        writeFileSync(tmp, JSON.stringify({ nonce, n, digest }) + "\n");
        renameSync(tmp, join(checksDir, `loop-request-${nonce}-${n}.json`));
        asked = n;
        askedAt = now();
      } catch {
        // No mailbox: no verdict will come, and the guard goes on without one.
      }
    },
    poll() {
      // The oldest question still open: an answer is read once, and a malformed one is dropped.
      while (read < asked) {
        const path = join(checksDir, `loop-answer-${nonce}-${read + 1}.json`);
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          // A lost answer must not disable the judge: past the timeout the open questions are given up on.
          if (now() - askedAt < timeoutMs) return null;
          read = asked;
          return "expired";
        }
        read += 1;
        rmSync(path, { force: true });
        try {
          const verdict = verdictOf(text);
          if (verdict) return verdict;
        } catch {
          // half-written or not JSON: dropped
        }
      }
      return null;
    },
  };
}
