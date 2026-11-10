// The loop guard's judge, over the /out/checks mailbox the luna tools already use: the guard's question is
// a request file the machine's build watch reads; its verdict is an answer file read on a later call. Neither
// side waits for the other: `ask` returns at once and `poll` looks once. It never throws.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { JudgePort } from "./session.ts";
import type { Verdict } from "./guard.ts";

/** The most a redirect may hold, as the pack's answer allows. */
const REDIRECT_MAX = 1200;

/** The answer file's body as a verdict, or null when it is not one. The file is the machine's, but /out is writable by the container, so it is read as untrusted. */
function verdictOf(text: string): Verdict | null {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { stuck, confidence, cause, redirect } = body as Record<string, unknown>;
  if (typeof stuck !== "boolean" || typeof confidence !== "number" || !Number.isFinite(confidence) || typeof cause !== "string") return null;
  const note = typeof redirect === "string" ? redirect.slice(0, REDIRECT_MAX) : "";
  return { stuck, confidence: Math.min(1, Math.max(0, confidence)), cause, ...(note ? { redirect: note } : {}) };
}

/** The judge port over the checks directory, or null when the run has none (the guard then keeps its backstop). */
export function mailboxJudge(checksDir: string | undefined): JudgePort | null {
  if (!checksDir) return null;
  let asked = 0;
  let read = 0;
  return {
    ask(digest) {
      try {
        const n = asked + 1;
        mkdirSync(checksDir, { recursive: true });
        const tmp = join(checksDir, `.loop-request-${n}.json.tmp`);
        writeFileSync(tmp, JSON.stringify({ n, digest }) + "\n");
        renameSync(tmp, join(checksDir, `loop-request-${n}.json`));
        asked = n;
      } catch {
        // No mailbox: no verdict will come, and the guard goes on without one.
      }
    },
    poll() {
      // The oldest question still open: an answer is read once, and a malformed one is dropped.
      while (read < asked) {
        const path = join(checksDir, `loop-answer-${read + 1}.json`);
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          return null;
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
