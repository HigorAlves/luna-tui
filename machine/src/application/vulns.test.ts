import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VulnTriageContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type CodeScanningAlert, type DependabotAlert, GitHubError } from "./github.ts";
import { POLICY_PATH, Vulns } from "./vulns.ts";
import { WikiError } from "./wiki.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vulns-"));
});

const dependabot = (over: Partial<DependabotAlert> = {}): DependabotAlert => ({
  number: 7,
  package: "lodash",
  ecosystem: "npm",
  severity: "high",
  manifestPath: "pnpm-lock.yaml",
  vulnerableRange: "< 4.17.21",
  patchedVersion: "4.17.21",
  ghsa: "GHSA-aaaa",
  cve: null,
  summary: "Prototype pollution",
  url: "https://github.com/acme/web/security/dependabot/7",
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});
const scanning = (over: Partial<CodeScanningAlert> = {}): CodeScanningAlert => ({
  number: 3,
  rule: "js/sql-injection",
  severity: "critical",
  tool: "CodeQL",
  path: "src/db.ts",
  url: "https://github.com/acme/web/security/code-scanning/3",
  createdAt: "2026-11-02T00:00:00Z",
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({ lane: "fast", deadline: "2026-12-01", severity: "high", title: "Bump lodash to 4.17.21", goal: "Close alert 7.", acceptance_criteria: ["The alert closes"], reason: "A patch bump.", ...over });

interface Fakes {
  dependabot?: DependabotAlert[] | "unknown" | Error;
  scanning?: CodeScanningAlert[] | "unknown";
  policy?: string | Error | null;
  triage?: (context: VulnTriageContext) => Promise<unknown>;
  now?: string;
  repoPath?: string | null;
}
function build(fakes: Fakes = {}) {
  const state: { dependabot: DependabotAlert[] | "unknown" | Error; scanning: CodeScanningAlert[] | "unknown"; now: string } = { dependabot: fakes.dependabot ?? [], scanning: fakes.scanning ?? [], now: fakes.now ?? "2026-11-16T10:00:00Z" };
  const github = {
    dependabotAlerts: vi.fn(async (_slug: string) => {
      if (state.dependabot instanceof Error) throw state.dependabot;
      return state.dependabot;
    }),
    codeScanningAlerts: vi.fn(async (_slug: string) => state.scanning),
  };
  const wiki = {
    readPages: vi.fn(async (_slug: string, prefix: string) => {
      if (fakes.policy instanceof Error) throw fakes.policy;
      return fakes.policy == null ? [] : [{ path: prefix, text: fakes.policy }];
    }),
  };
  const triage = vi.fn(fakes.triage ?? (async (_context: VulnTriageContext) => answer()));
  let made = 0;
  const pipeline = {
    createTask: vi.fn(async (_input: unknown) => ({ id: `card-${++made}` })),
    record: vi.fn(async (_id: string, _kind: string, _payload: Record<string, unknown>) => {}),
  };
  const log = vi.fn();
  const vulns = new Vulns({
    github: github as never,
    wiki,
    triage,
    pipeline: pipeline as never,
    repos: async () => ["acme/web"],
    repoPathOf: async () => (fakes.repoPath === undefined ? "/repos/web" : fakes.repoPath),
    stateDir,
    log,
    now: () => new Date(state.now),
  });
  return { vulns, github, wiki, triage, pipeline, log, state };
}
const stateFile = () => JSON.parse(readFileSync(join(stateDir, "compliance", "vulns", "acme__web.json"), "utf8"));

describe("the vulnerability job", () => {
  it("turns a new alert into a card: the triage's title, goal and criteria, the alert as its source, the lane in its text", async () => {
    const { vulns, pipeline, triage, wiki } = build({ dependabot: [dependabot()], policy: "High: 14 days." });
    await vulns.tick();
    expect(wiki.readPages).toHaveBeenCalledWith("acme/web", POLICY_PATH);
    const context = triage.mock.calls[0]![0];
    expect(context).toMatchObject({ repo: "acme/web", today: "2026-11-16", policy: { path: POLICY_PATH, text: "High: 14 days." }, alert: { source: "dependabot", number: 7, severity: "high", package: "lodash", patchedVersion: "4.17.21", title: "Prototype pollution", rule: null } });
    expect(pipeline.createTask).toHaveBeenCalledTimes(1);
    const task = pipeline.createTask.mock.calls[0]![0] as { title: string; description: string; criteria: string[]; repoPath: string; source: unknown; hints: unknown; originMachine: string };
    expect(task).toMatchObject({ title: "Bump lodash to 4.17.21", criteria: ["The alert closes"], repoPath: "/repos/web", originMachine: "automation", hints: { kind: "security" } });
    expect(task.source).toMatchObject({ kind: "github_alert", repo: "acme/web", alert: 7, tool: "dependabot", url: "https://github.com/acme/web/security/dependabot/7" });
    expect(task.source).not.toHaveProperty("number");
    expect((task.source as { labels?: string[] }).labels ?? []).not.toContain("security");
    expect(task.description).toContain("Close alert 7.");
    expect(task.description).toContain("Lane: fast");
    expect(task.description).toContain("Deadline: 2026-12-01");
    expect(stateFile()).toEqual({ schema: 1, alerts: { "dependabot:7": { cardId: "card-1", deadline: "2026-12-01", lane: "fast", severity: "high", overdue: false } } });
  });

  it("labels a card security only for a critical alert, so a routine bump is not triaged up to P0", async () => {
    const labelsFor = async (severity: string) => {
      stateDir = mkdtempSync(join(tmpdir(), "vulns-"));
      const { vulns, pipeline } = build({ dependabot: [dependabot()], triage: async () => answer({ severity }) });
      await vulns.tick();
      return (pipeline.createTask.mock.calls[0]![0] as { source: { labels?: string[] } }).source.labels ?? [];
    };
    expect(await labelsFor("critical")).toEqual(["security"]);
    for (const severity of ["high", "medium", "low"]) expect(await labelsFor(severity)).not.toContain("security");
  });

  it("reads code-scanning alerts too, and a hold card says it waits for the person", async () => {
    const { vulns, pipeline, triage } = build({ scanning: [scanning()], triage: async () => answer({ lane: "hold", severity: "critical", title: "Fix SQL injection in db.ts" }) });
    await vulns.tick();
    expect(triage.mock.calls[0]![0].alert).toMatchObject({ source: "code_scanning", number: 3, rule: "js/sql-injection", tool: "CodeQL", path: "src/db.ts", title: "js/sql-injection", package: null });
    const task = pipeline.createTask.mock.calls[0]![0] as { description: string; source: unknown };
    expect(task.source).toMatchObject({ kind: "github_alert", tool: "code_scanning", alert: 3 });
    expect(task.description).toContain("Lane: hold");
    expect(task.description).toMatch(/waits for a person/i);
  });

  it("a wiki without the policy, or one that cannot be read, is a null policy: the triage still runs", async () => {
    for (const policy of [null, new WikiError("no wiki")]) {
      stateDir = mkdtempSync(join(tmpdir(), "vulns-"));
      const { vulns, triage } = build({ dependabot: [dependabot()], policy });
      await vulns.tick();
      expect(triage.mock.calls[0]![0].policy).toBeNull();
    }
  });

  it("makes no second card for an alert it has seen, and drops an alert that closed", async () => {
    const { vulns, pipeline, triage, state } = build({ dependabot: [dependabot(), dependabot({ number: 8 })] });
    await vulns.tick();
    await vulns.tick();
    expect(pipeline.createTask).toHaveBeenCalledTimes(2);
    expect(triage).toHaveBeenCalledTimes(2);
    state.dependabot = [dependabot()];
    await vulns.tick();
    expect(Object.keys(stateFile().alerts)).toEqual(["dependabot:7"]);
  });

  it("keeps an alert for the next tick when the triage fails or answers badly: no card", async () => {
    let calls = 0;
    const { vulns, pipeline, log } = build({ dependabot: [dependabot()], triage: async () => (++calls === 1 ? Promise.reject(new Error("model down")) : answer({ lane: "slow" })) });
    await vulns.tick();
    await vulns.tick();
    expect(pipeline.createTask).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toContain("model down");
  });

  it("skips a repo whose alerts are unknown with one log line, and keeps its state", async () => {
    const { vulns, pipeline, log, state } = build({ dependabot: [dependabot()] });
    await vulns.tick();
    state.dependabot = "unknown";
    await vulns.tick();
    expect(pipeline.createTask).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("acme/web");
    expect(Object.keys(stateFile().alerts)).toEqual(["dependabot:7"]);
  });

  it("reads each source on its own: unreadable code scanning still makes the Dependabot cards and marks them overdue", async () => {
    const { vulns, pipeline, state, log } = build({ dependabot: [dependabot()], scanning: "unknown", triage: async () => answer({ deadline: "2026-11-20" }) });
    await vulns.tick();
    expect(pipeline.createTask).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain("code-scanning");
    state.now = "2026-11-21T00:01:00Z";
    await vulns.tick();
    expect(pipeline.record).toHaveBeenCalledWith("card-1", "compliance.deadline", expect.objectContaining({ key: "dependabot:7" }));
  });

  it("keeps the state keys of an unreadable source, creates none for it, and still drops a closed alert of the readable one", async () => {
    const { vulns, pipeline, state } = build({ dependabot: [dependabot(), dependabot({ number: 8 })], scanning: [scanning()] });
    await vulns.tick();
    expect(pipeline.createTask).toHaveBeenCalledTimes(3);
    state.scanning = "unknown";
    state.dependabot = [dependabot()];
    await vulns.tick();
    expect(Object.keys(stateFile().alerts).sort()).toEqual(["code_scanning:3", "dependabot:7"]);
    state.dependabot = "unknown";
    state.scanning = [scanning(), scanning({ number: 4 })];
    await vulns.tick();
    expect(Object.keys(stateFile().alerts).sort()).toEqual(["code_scanning:3", "code_scanning:4", "dependabot:7"]);
  });

  it("skips a repo the machine has no checkout of, and a failed GitHub read does not stop the other repos", async () => {
    const none = build({ dependabot: [dependabot()], repoPath: null });
    await none.vulns.tick();
    expect(none.pipeline.createTask).not.toHaveBeenCalled();
    const broken = build({ dependabot: new GitHubError("boom") });
    await broken.vulns.tick();
    expect(broken.log.mock.calls[0]![0]).toContain("boom");
  });

  it("marks an alert still open after its deadline overdue once, with an event on its card, and lists it", async () => {
    const { vulns, pipeline, state } = build({ dependabot: [dependabot()], triage: async () => answer({ deadline: "2026-11-20" }) });
    await vulns.tick();
    expect((await vulns.list())[0]!.overdue).toBe(false);
    state.now = "2026-11-20T23:59:00Z";
    await vulns.tick();
    expect((await vulns.list())[0]!.overdue).toBe(false);
    state.now = "2026-11-21T00:01:00Z";
    await vulns.tick();
    await vulns.tick();
    expect(await vulns.list()).toEqual([{ repo: "acme/web", key: "dependabot:7", severity: "high", lane: "fast", deadline: "2026-11-20", cardId: "card-1", overdue: true }]);
    expect(pipeline.record).toHaveBeenCalledTimes(1);
    expect(pipeline.record).toHaveBeenCalledWith("card-1", "compliance.deadline", { key: "dependabot:7", deadline: "2026-11-20", repo: "acme/web" });
  });
});
