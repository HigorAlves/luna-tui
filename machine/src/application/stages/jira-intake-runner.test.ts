import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { issueOf } from "../../test/jira.ts";
import { createJiraTriager, jiraContext } from "./jira-intake-runner.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const issue = issueOf({ key: "PLAT-123", summary: "Login page", description: "Users sign in.", issueType: "Story", priority: "High", labels: ["luna"], dueAt: "2026-10-31", comments: [{ author: "Marta", authorId: "A1", text: "please", created: "" }] });
const answer = { verdict: "ready", reason: "clear", title: "Add the login page", description: "Users sign in.", criteria: ["/login renders"] };

const output = (over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 3, ok: true, outcome: "pass", summary: "", answer, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null,
  usage: { turns: 4, costUsd: 0.031, durationMs: 9000, model: "claude-sonnet-5" }, error: null, rateLimited: false, resetsAt: null, ...over,
});

let stateDir: string;
let seen: SandboxRun[];
let logs: string[];

function fakeSandbox(body: StageOutput | null, result: Partial<SandboxResult> = {}): (run: SandboxRun) => Promise<SandboxResult> {
  return async (run) => {
    seen.push(run);
    const out = join(run.runDir, "out");
    mkdirSync(out, { recursive: true });
    if (body) writeFileSync(join(out, "result.json"), JSON.stringify(body));
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log"), ...result };
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jira-intake-"));
  seen = [];
  logs = [];
});

const deps = (sandbox: (run: SandboxRun) => Promise<SandboxResult>) => ({ image: "hardness-runner:dev", credential: { kind: "token" as const, value: "x" } as never, stateDir, sandbox, now: () => NOW, log: (l: string) => logs.push(l) });

describe("createJiraTriager", () => {
  it("runs the jira_intake pack over the repo checkout read-only with the issue in context.jira, and answers the verdict", async () => {
    const triager = createJiraTriager(deps(fakeSandbox(output())));
    const verdict = await triager.triage(issue, "/r/a");
    expect(verdict).toEqual(answer);
    expect(seen).toHaveLength(1);
    const run = seen[0]!;
    expect(run).toMatchObject({ name: "hardness-jira-intake-plat-123-2026-10-28t12-00-00-000z", image: "hardness-runner:dev", worktree: "/r/a", writable: false, gitDir: null, labels: { luna: "jira-intake" }, timeoutMs: 300_000 });
    expect(run.runDir).toBe(join(stateDir, "jira-intake", "PLAT-123-2026-10-28T12-00-00-000Z"));
    const input = StageInput.parse(run.input);
    expect(input.pack).toBe("jira_intake");
    expect(input.context.jira).toEqual(jiraContext(issue, "/r/a"));
    expect(input.context.jira).toMatchObject({ key: "PLAT-123", comments: ["Marta: please"], repoPath: "/r/a", labels: ["luna"], dueAt: "2026-10-31" });
    expect(logs).toEqual(["jira intake: PLAT-123 ready: clear (4 turn(s) · $0.0310)"]);
  });

  it("uses an empty folder under the run dir when the repo is unknown", async () => {
    const triager = createJiraTriager(deps(fakeSandbox(output())));
    await triager.triage(issue, null);
    expect(seen[0]!.worktree).toBe(join(stateDir, "jira-intake", "PLAT-123-2026-10-28T12-00-00-000Z", "work"));
    expect(existsSync(seen[0]!.worktree)).toBe(true);
    expect(StageInput.parse(seen[0]!.input).task.repoPath).toBe("");
  });

  it("answers null and logs why when the run times out, leaves no result, fails, or answers off-schema", async () => {
    expect(await createJiraTriager(deps(fakeSandbox(null, { timedOut: true }))).triage(issue, null)).toBeNull();
    expect(await createJiraTriager(deps(fakeSandbox(null, { exitCode: 3 }))).triage(issue, null)).toBeNull();
    expect(await createJiraTriager(deps(fakeSandbox(output({ ok: false, error: "usage limit" })))).triage(issue, null)).toBeNull();
    expect(await createJiraTriager(deps(fakeSandbox(output({ answer: { verdict: "maybe" } })))).triage(issue, null)).toBeNull();
    expect(logs).toEqual([
      "jira intake: PLAT-123 failed: timed out after 5 minutes",
      "jira intake: PLAT-123 failed: the container left no result (exit code 3)",
      "jira intake: PLAT-123 failed: usage limit",
      expect.stringContaining("jira intake: PLAT-123 failed: the answer did not match the schema"),
    ]);
  });
});
