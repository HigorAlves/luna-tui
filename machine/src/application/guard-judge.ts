// The judge the stage guard asks (RFC 0012, B6). SafeAgents sends a tool call atif-scan found suspicious to an OpenAI-compatible endpoint and expects
// `allow` or `block`. The machine serves that endpoint itself, so the model call is the `guard_judge` pack on Jev and never a request from the
// container to an API. This file is the logic, pure and testable: the port a run's wiring uses (`register`, `revoke`) and `review`, which takes the
// bearer and the user message of one request and answers a status. The listener (adapters/http/guard-judge.ts) only speaks HTTP.
//
// What the judge never does: pass the text on unclean (the task, the arguments and the findings go through `safe()` and are capped), echo model
// text (the reason is the findings' own ids and titles, in fixed words), or keep the arguments (the decision record's context drops them, see
// domain/record-context.ts). A key is a per-run token for this endpoint and no credential: it is revoked when the run's network goes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { PACKS } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { Trust } from "../domain/trust.ts";
import { type PackRunsPort, ownCalls } from "./pack-runs.ts";

/** Calls one run's guard may make to the judge; past it the endpoint declines the call (200, `block`, for any trust). */
export const JUDGE_MAX_CALLS = 5;
/** How long a call waits for the pack: under SafeAgents' own 30 s, so the guard hears 503 from here rather than time out first. */
export const JUDGE_TIMEOUT_MS = 25_000;
/** What reaches the pack: the task's last 4000 characters (the latest ask matters most, as in SafeAgents), the call's first 4000, ten findings. */
export const TASK_MAX = 4000;
export const ARGS_MAX = 4000;
export const FINDINGS_MAX = 10;

/** What a run's wiring needs: a key for the run's guard, and to take it back. */
export interface GuardJudgePort {
  register(taskId: string, trust: Trust): string;
  revoke(token: string): void;
}

/**
 * 401 is a key it does not know and 503 a pack that failed or was too slow: both are the machine's faults, and `--judge-fail-closed` covers an untrusted card. Everything the stage can force (a run past its
 * calls, a message that is not SafeAgents') is a 200 `block` in fixed words instead of an HTTP error, so the outcome never rests on SafeAgents' fail-open or fail-closed rule.
 */
export type JudgeAnswer = { status: 200; verdict: "allow" | "block"; reason: string } | { status: 401 | 503 };

/** What the judge says to a call it will not weigh. Fixed words, for any trust. */
export const JUDGE_DECLINED = "the judge declined this call";

export interface GuardJudgeDeps {
  /** The runs the judge's packs go through: their own `PackRuns` (a small cap), so judge calls never wait behind the notch's. */
  runs: PackRunsPort;
  /** One line per call, never its content. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

interface Grant {
  digest: Buffer;
  taskId: string;
  trust: Trust;
  calls: number;
}

const digestOf = (token: string): Buffer => createHash("sha256").update(token).digest();

const HEAD = "<task>\n";
const TASK_END = "\n</task>\n\n<tool_call name=";
const ARGS_END = "\n</tool_call>\n\n<scanner_findings>\n";
const FINDINGS_END = "\n</scanner_findings>";
const NAME = /^("(?:[^"\\]|\\.)*")>\n/;
const FINDING = /^- (\S+) \((\w+)\): (.*)$/;

/** The parts of SafeAgents' user message (`build_prompt`): its three blocks, in order. Null when it is not that, or when text inside a block
 *  forges another block's marker (each marker must occur exactly once): which block is which would then be a guess. */
export function parseJudgeMessage(text: string): { task: string; tool: string; args: string; findings: Array<{ id: string; severity: string; title: string }> } | null {
  if (!text.startsWith(HEAD) || !text.endsWith(FINDINGS_END)) return null;
  const once = (marker: string): number => {
    const first = text.indexOf(marker);
    return first === -1 || text.indexOf(marker, first + 1) !== -1 ? -1 : first;
  };
  const taskEnd = once(TASK_END);
  if (taskEnd < HEAD.length) return null;
  const nameAt = taskEnd + TASK_END.length;
  const name = NAME.exec(text.slice(nameAt));
  if (!name) return null;
  const argsStart = nameAt + name[0].length;
  const argsEnd = once(ARGS_END);
  if (argsEnd < argsStart) return null;
  const findingsStart = argsEnd + ARGS_END.length;
  const findingsEnd = text.length - FINDINGS_END.length;
  // The closing marker is also the end of the text: a second one inside it would be a forged block.
  if (text.indexOf(FINDINGS_END) !== findingsEnd || findingsEnd < findingsStart) return null;
  let tool: unknown;
  try {
    tool = JSON.parse(name[1]!);
  } catch {
    return null;
  }
  if (typeof tool !== "string") return null;
  const findings = text
    .slice(findingsStart, findingsEnd)
    .split("\n")
    .flatMap((line) => {
      const found = FINDING.exec(line);
      return found ? [{ id: found[1]!, severity: found[2]!, title: found[3]! }] : [];
    });
  return { task: text.slice(HEAD.length, taskEnd), tool, args: text.slice(argsStart, argsEnd), findings };
}

/** The reason SafeAgents shows the agent and the journal: the findings' own ids and titles in fixed words, never a model's text. */
function reasonOf(verdict: "allow" | "block", findings: Array<{ id: string; title: string }>): string {
  if (verdict === "allow") return "Allowed by the judge.";
  const named = findings.slice(0, FINDINGS_MAX).map((f) => `${f.id} (${f.title})`);
  return `Blocked by the judge.${named.length > 0 ? ` Findings: ${named.join("; ")}.` : ""}`;
}

export class GuardJudge implements GuardJudgePort {
  private readonly grants = new Map<string, Grant>();
  private readonly runs: PackRunsPort;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(deps: GuardJudgeDeps) {
    this.runs = ownCalls(deps.runs);
    this.log = deps.log ?? ((line) => console.log(line));
    this.timeoutMs = deps.timeoutMs ?? JUDGE_TIMEOUT_MS;
  }

  /** A random 256-bit key for one run's guard (hex). The run's `trust` is kept with it. */
  register(taskId: string, trust: Trust): string {
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, { digest: digestOf(token), taskId, trust, calls: 0 });
    return token;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  /** The grant a bearer names: every grant is compared, with no early exit, on equal-length digests. */
  private find(bearer: string | null): Grant | null {
    if (bearer === null || bearer === "") return null;
    const given = digestOf(bearer);
    let found: Grant | null = null;
    for (const grant of this.grants.values()) if (timingSafeEqual(given, grant.digest)) found = grant;
    return found;
  }

  /** Whether a bearer names a run's grant: the listener asks before it reads a body. */
  knows(bearer: string | null): boolean {
    return this.find(bearer) !== null;
  }

  /** One request: 401 for a key it does not know, a 200 `block` past the run's calls or for a message that is not SafeAgents', 503 when the pack fails or is too slow. */
  async review(bearer: string | null, userText: string): Promise<JudgeAnswer> {
    const grant = this.find(bearer);
    if (!grant) return { status: 401 };
    // Every call of a run counts, a malformed one too: the cap bounds what one guard can spend.
    grant.calls += 1;
    const declined = (why: string): JudgeAnswer => {
      this.log(`guard judge: declined a call for ${grant.trust} card ${grant.taskId}: ${why}`);
      return { status: 200, verdict: "block", reason: JUDGE_DECLINED };
    };
    if (grant.calls > JUDGE_MAX_CALLS) return declined("past the run's calls");
    const parsed = parseJudgeMessage(userText);
    if (!parsed) return declined("not SafeAgents' message");
    const task = safe(parsed.task);
    const findings = parsed.findings.slice(0, FINDINGS_MAX).map((f) => ({ id: safe(f.id).slice(0, 100), severity: safe(f.severity).slice(0, 20), title: safe(f.title).slice(0, 300) }));
    const guard = { task: task.length > TASK_MAX ? task.slice(-TASK_MAX) : task, tool: safe(parsed.tool).slice(0, 100), args: safe(parsed.args).slice(0, ARGS_MAX), findings };
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const out = await this.runs.run({ pack: "guard_judge", context: { check: { kind: "guard", guard } }, taskId: grant.taskId, stage: "guard" }, "guard", signal);
      const harmful = out.answer.harmful as { value?: unknown; p?: unknown } | undefined;
      // Block only on a sure yes: the pack's own bar for "proceed" on its one question.
      const bar = PACKS.guard_judge.policy.harmful!.proceed;
      const verdict = harmful?.value === true && typeof harmful.p === "number" && harmful.p >= bar ? "block" : "allow";
      this.log(`guard judge: ${verdict} for ${grant.trust} card ${grant.taskId} (${grant.calls}/${JUDGE_MAX_CALLS})`);
      return { status: 200, verdict, reason: reasonOf(verdict, findings) };
    } catch (error) {
      this.log(`guard judge: no verdict for card ${grant.taskId}: ${safe(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      return { status: 503 };
    }
  }
}
