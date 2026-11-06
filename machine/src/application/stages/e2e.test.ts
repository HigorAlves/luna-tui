import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Learned } from "../decision-truth.ts";
import { tagged } from "../decision-truth.ts";
import type { Decide } from "./check-decide.ts";
import { detectWeb, e2eRunner, missingQaImageRunner, touchesRenderedSurface, webRoots } from "./e2e.ts";
import type { StageContext, StageResult } from "../ports.ts";
import type { OpenAppInput } from "../app-session.ts";
import { parseLunaConfig } from "../../domain/luna-config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-"));
});
const pkg = (value: unknown) => writeFileSync(join(dir, "package.json"), JSON.stringify(value));

describe("detectWeb", () => {
  it("is false for a repo with no web surface", async () => {
    pkg({ name: "lib", scripts: { test: "vitest" }, dependencies: { zod: "1" } });
    expect(await detectWeb(dir)).toBe(false);
  });
  it("is false for an empty directory", async () => {
    expect(await detectWeb(dir)).toBe(false);
  });
  it.each(["dev", "start", "preview"])("is true with a %s script", async (name) => {
    pkg({ scripts: { [name]: "x" } });
    expect(await detectWeb(dir)).toBe(true);
  });
  it("is true with a framework dependency, dev or not", async () => {
    pkg({ devDependencies: { svelte: "5" } });
    expect(await detectWeb(dir)).toBe(true);
  });
  it("is true with an index.html at the root or one level down", async () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "index.html"), "<html>");
    expect(await detectWeb(dir)).toBe(true);
  });
  it("ignores an index.html under node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.html"), "<html>");
    expect(await detectWeb(dir)).toBe(false);
  });

  it("looks into workspace packages, where a monorepo keeps its web app", async () => {
    pkg({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] });
    mkdirSync(join(dir, "packages", "lib"), { recursive: true });
    writeFileSync(join(dir, "packages", "lib", "package.json"), JSON.stringify({ name: "lib", scripts: { test: "vitest" } }));
    expect(await detectWeb(dir)).toBe(false);
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "15" } }));
    expect(await detectWeb(dir)).toBe(true);
  });
});

describe("webRoots", () => {
  it("names the web package dirs: the root itself, or the workspace apps that are web", async () => {
    expect(await webRoots(dir)).toEqual([]);
    pkg({ name: "root", private: true, workspaces: ["apps/*"] });
    mkdirSync(join(dir, "apps", "web"), { recursive: true });
    writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { vite: "7" } }));
    mkdirSync(join(dir, "apps", "api"), { recursive: true });
    writeFileSync(join(dir, "apps", "api", "package.json"), JSON.stringify({ name: "api", scripts: { test: "vitest" } }));
    expect(await webRoots(dir)).toEqual(["apps/web"]);
    pkg({ name: "root", scripts: { dev: "vite" } });
    expect(await webRoots(dir)).toEqual(["", "apps/web"]);
  });
});

describe("touchesRenderedSurface", () => {
  it("counts any source under a web package's src/, since a .ts file may well render the page", () => {
    expect(touchesRenderedSurface(["src/cart.ts"], [""])).toBe(true);
    expect(touchesRenderedSurface(["apps/web/src/cart.ts"], ["apps/web"])).toBe(true);
    expect(touchesRenderedSurface(["apps/api/src/cart.ts"], ["apps/web"])).toBe(false);
    expect(touchesRenderedSurface(["src/cart.test.ts", "test/cart.ts", "src/__tests__/a.ts"], [""])).toBe(false);
    expect(touchesRenderedSurface(["src/cart.ts"])).toBe(false);
  });

  it("is true for markup, styles, assets, UI folders and the package manifest", () => {
    for (const file of ["src/App.tsx", "index.html", "styles/a.css", "app/page.ts", "public/logo.svg", "package.json", "src/components/Button.ts", "web/templates/home.j2"]) {
      expect(touchesRenderedSurface([file]), file).toBe(true);
    }
  });

  it("is false for a change nothing on screen depends on", () => {
    expect(touchesRenderedSurface(["src/lib/csv.ts", "src/lib/csv.test.ts", "README.md", "server/api.go", ".github/workflows/ci.yml"])).toBe(false);
    expect(touchesRenderedSurface([])).toBe(false);
  });
});

const context = (): StageContext =>
  ({ task: { worktreePath: dir }, stage: "e2e", attempt: 1, runId: "r", approvals: [] }) as unknown as StageContext;

const packReturning = (result: StageResult) => vi.fn(async () => result);
const answered = (answer: Record<string, unknown>): StageResult => ({
  outcome: "pass",
  detail: { summary: "s", answer },
});

describe("e2eRunner", () => {
  it("skips with a reason, without running the pack, when there is no web surface", async () => {
    const runPack = packReturning(answered({}));
    const result = await e2eRunner({ runPack, detectWeb: async () => false })(context());
    expect(runPack).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "pass",
      detail: { step: "e2e", skipped: true, reason: "no web surface detected" },
    });
  });

  it("skips, without running the pack, when the repo's policy says qa: none", async () => {
    const runPack = packReturning(answered({}));
    const policy = async () => ({ qa: "none" as const });
    const result = await e2eRunner({ runPack, detectWeb: async () => true, policy })(context());
    expect(runPack).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "pass", detail: { step: "e2e", skipped: true, reason: "the repo's config says qa: none" } });
  });

  it("runs the pack for a .ts change under the web package's src", async () => {
    const runPack = packReturning(answered({ verdict: "pass", summary: "ok", criteria: [] }));
    await e2eRunner({ runPack, detectWeb: async () => true, webRoots: async () => [""], changedFiles: async () => ["src/cart.ts"] })(context());
    expect(runPack).toHaveBeenCalledTimes(1);
  });

  it("skips, without running the pack, when the diff touches no rendered surface", async () => {
    const runPack = packReturning(answered({}));
    const run = e2eRunner({ runPack, detectWeb: async () => true, changedFiles: async () => ["src/lib/csv.ts", "docs/x.md"] });
    const result = await run(context());
    expect(runPack).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "pass",
      detail: { step: "e2e", skipped: true, reason: "the change touches no rendered surface", files: ["src/lib/csv.ts", "docs/x.md"] },
    });
  });

  it("runs the pack when the diff touches the UI, or when the base is unknown", async () => {
    for (const changed of [async () => ["src/App.tsx"], async () => null]) {
      const runPack = packReturning(answered({ verdict: "pass", summary: "ok", criteria: [] }));
      await e2eRunner({ runPack, detectWeb: async () => true, changedFiles: changed })(context());
      expect(runPack).toHaveBeenCalledTimes(1);
    }
  });

  it("passes an escalated pack result straight through", async () => {
    const runPack = packReturning({ outcome: "escalated", detail: { reason: "no dev server could start", options: ["add a dev script"] } });
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result).toMatchObject({ outcome: "escalated", detail: { step: "e2e", reason: "no dev server could start" } });
  });

  it.each([
    ["pass", "pass"],
    ["skipped", "pass"],
    ["partial", "fail"],
    ["fail", "fail"],
  ] as const)("maps verdict %s to %s", async (verdict, outcome) => {
    const criteria = [{ text: "works", result: "pass", evidence: ["a.png"] }];
    const runPack = packReturning(answered({ verdict, summary: "done", criteria }));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.outcome).toBe(outcome);
    expect(result.detail).toMatchObject({ step: "e2e", verdict, summary: "done", criteria });
  });

  it("notes a skipped verdict", async () => {
    const runPack = packReturning(answered({ verdict: "skipped", summary: "no server" }));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.detail).toMatchObject({ skipped: true });
    expect(result.detail?.note).toEqual(expect.stringContaining("skipped"));
  });

  it("keeps a pack failure as is, with the step recorded", async () => {
    const runPack = packReturning({ outcome: "fail", detail: { error: "timed out" } });
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result).toMatchObject({ outcome: "fail", detail: { step: "e2e", error: "timed out" } });
  });

  it("keeps artifacts and run facts from the pack", async () => {
    const artifacts = [{ kind: "screenshot" as const, path: "/x/a.png", label: "a.png", sha256: "s" }];
    const runPack = packReturning({ ...answered({ verdict: "pass" }), artifacts, run: { containerId: "c" } });
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.artifacts).toBe(artifacts);
    expect(result.run).toEqual({ containerId: "c" });
  });

  it("treats a pack with no verdict as a fail", async () => {
    const runPack = packReturning(answered({}));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.outcome).toBe("fail");
  });
});

describe("e2e_failure_cause", () => {
  const criteria = [
    { text: "login works", result: "fail", evidence: [] },
    { text: "logout works", result: "pass", evidence: [] },
  ];
  const failing = answered({ verdict: "fail", summary: "login broke", criteria });
  const passing = answered({ verdict: "pass", summary: "ok" });
  const cause = (choice: string, confidence = 0.9) => ({ cause: { choice, confidence } });
  const run = (runPack: (context: StageContext) => Promise<StageResult>, decide: Decide | null) =>
    e2eRunner({ runPack, detectWeb: async () => true, decide, overrides: async () => ({}) })({ ...context(), attempt: 2 });

  it("re-runs the pack once on an environment flake, and passes when the second run does", async () => {
    const runPack = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(passing);
    const decide = vi.fn<Decide>(async () => cause("env_flake"));
    const result = await run(runPack, decide);
    expect(runPack).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ rerun: true, cause: "env_flake" });
    const [pack, check] = decide.mock.calls[0]!;
    expect(pack).toBe("e2e_failure_cause");
    expect(check).toEqual({ kind: "e2e", e2e: { verdict: "fail", summary: "login broke", attempt: 2, criteria: [{ text: "login works", result: "fail" }] } });
  });

  it("takes the number of environment-flake re-runs from the repo's luna.yaml `verify.env_flake_retries`", async () => {
    const withRetries = (n: number, runPack: (context: StageContext) => Promise<StageResult>) =>
      e2eRunner({ runPack, detectWeb: async () => true, decide: async () => cause("env_flake"), overrides: async () => ({}), policy: async () => ({ qa: "web", factory: { verify: { env_flake_retries: n } } }) })({ ...context(), attempt: 2 });
    const none = vi.fn().mockResolvedValue(failing);
    expect((await withRetries(0, none)).outcome).toBe("fail");
    expect(none).toHaveBeenCalledTimes(1);
    const three = vi.fn().mockResolvedValue(failing);
    const spent = await withRetries(3, three);
    expect(three).toHaveBeenCalledTimes(4);
    expect(spent).toMatchObject({ outcome: "escalated", detail: { reason: expect.stringContaining("failed 4 times") } });
    const second = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(failing).mockResolvedValueOnce(passing);
    expect((await withRetries(2, second)).outcome).toBe("pass");
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("clears the run's out/ folder before the re-run, so the first attempt's artifacts never reach Evidence", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "e2e-state-"));
    const ctx = { ...context(), attempt: 2 };
    const stale = join(stateDir, "runs", ctx.runId, "out", "files", "qa");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "stale.png"), "x");
    const runPack = vi.fn(async () => (existsSync(join(stale, "stale.png")) ? failing : passing));
    const result = await e2eRunner({ runPack, detectWeb: async () => true, decide: async () => cause("env_flake"), overrides: async () => ({}), stateDir })(ctx);
    expect(runPack).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("pass");
    expect(existsSync(join(stateDir, "runs", ctx.runId, "out"))).toBe(false);
  });

  it("drops malformed criteria rows before asking for the cause", async () => {
    const junk = answered({ verdict: "fail", summary: "broke", criteria: [null, "x", 7, { text: "login works", result: "fail", evidence: [] }, { result: "fail" }] });
    const runPack = vi.fn().mockResolvedValueOnce(junk).mockResolvedValueOnce(passing);
    const decide = vi.fn<Decide>(async () => cause("env_flake"));
    const result = await run(runPack, decide);
    expect(result.outcome).toBe("pass");
    expect(decide.mock.calls[0]![1].e2e?.criteria).toEqual([{ text: "login works", result: "fail" }]);
  });

  it("escalates as flaky_tests when the re-run fails too", async () => {
    const runPack = vi.fn().mockResolvedValue(failing);
    const result = await run(runPack, async () => cause("env_flake"));
    expect(runPack).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ step: "e2e", escalation: "flaky_tests", rerun: true, cause: "env_flake", reason: expect.stringContaining("login broke") });
    expect((result.detail as { options: string[] }).options).toHaveLength(2);
  });

  it.each(["product_bug", "test_bug"])("fails once with the cause recorded on %s", async (choice) => {
    const runPack = vi.fn().mockResolvedValue(failing);
    const result = await run(runPack, async () => cause(choice));
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ cause: choice });
  });

  it("treats a low-confidence flake as a product bug", async () => {
    const runPack = vi.fn().mockResolvedValue(failing);
    const result = await run(runPack, async () => cause("env_flake", 0.3));
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.detail).toMatchObject({ cause: "product_bug" });
  });

  it("writes the truth onto the cause's record once the re-run settles it: env_flake when it passed, not env_flake when it failed again", async () => {
    const told: Learned[] = [];
    const truth = { learned: async (fact: Learned) => (told.push(fact), true) };
    const decide: Decide = async () => tagged({ answer: cause("env_flake"), recordId: "rec-1" });
    const go = (runPack: (context: StageContext) => Promise<StageResult>) => e2eRunner({ runPack, detectWeb: async () => true, decide, overrides: async () => ({}), truth })({ ...context(), task: { id: "task-1", worktreePath: dir } as never });
    await go(vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(passing));
    await go(vi.fn().mockResolvedValue(failing));
    expect(told).toEqual([
      { pack: "e2e_failure_cause", recordId: "rec-1", label: { cause: { choice: "env_flake" } }, source: "e2e_rerun", taskId: "task-1" },
      { pack: "e2e_failure_cause", recordId: "rec-1", label: { cause: { choice: ["product_bug", "test_bug"] } }, source: "e2e_rerun", taskId: "task-1" },
    ]);
  });

  it("behaves as before without a decide, and on a pass", async () => {
    const runPack = vi.fn().mockResolvedValue(failing);
    const result = await run(runPack, null);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("fail");
    expect(result.detail).not.toHaveProperty("cause");
    const decide = vi.fn<Decide>(async () => cause("env_flake"));
    expect((await run(vi.fn().mockResolvedValue(passing), decide)).outcome).toBe("pass");
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("missingQaImageRunner", () => {
  it("passes with a note that e2e was skipped", async () => {
    const result = await missingQaImageRunner()(context());
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "e2e",
      skipped: true,
      note: "QA image missing (pnpm runner-qa:build); e2e skipped",
    });
  });
});

describe("the e2e stage and the app the machine starts", () => {
  const start = parseLunaConfig("verify:\n  e2e:\n    start:\n      command: npm start\n      port: 4000\nqa_targets:\n  - name: staging\n    url: https://staging.example.com\n");
  const answer = { verdict: "pass", summary: "ok", criteria: [] };
  const cause = (choice: string, confidence = 0.9) => ({ cause: { choice, confidence } });
  const pass = (): StageResult => ({ outcome: "pass", detail: { answer } });
  const base = (over: Record<string, unknown> = {}) => {
    const events: string[] = [];
    const extras: Array<Record<string, unknown> | undefined> = [];
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const opened = { ok: true as const, target: { name: "app" as const, baseUrl: "http://luna-app:4000" }, network: "net-app", aliases: ["luna-app"], close: async () => void events.push("close") };
    const runner = e2eRunner({
      runPack: async (_c: StageContext, extra?: unknown) => (events.push("pack"), extras.push(extra as never), pass()),
      detectWeb: async () => true,
      changedFiles: async () => null,
      policy: async () => start,
      headCommit: async () => "c".repeat(40),
      openApp: async (input: OpenAppInput) => (events.push(`open ${input.attempt}`), input.onBlocked("app", [{ host: "x.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }]), opened),
      ...over,
    } as never);
    const context = { task: { id: "t1", repoPath: "/repo", worktreePath: dir, branch: "task/x" }, stage: "e2e", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal, emit: async (k: string, p: Record<string, unknown>) => void emitted.push([k, p]) } as unknown as StageContext;
    return { runner, events, extras, emitted, context };
  };

  it("starts the app, hands the browser run that one target on the app's network, closes the app after, and records the preview", async () => {
    const h = base();
    const result = await h.runner(h.context);
    expect(h.events).toEqual(["open 10", "pack", "close"]);
    expect(h.extras[0]).toMatchObject({ qaTarget: { name: "app", baseUrl: "http://luna-app:4000", credential: null }, alsoJoin: ["net-app"], noProxy: ["luna-app"] });
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "e2e", preview: { kind: "start", url: "http://luna-app:4000" } } });
    expect(h.emitted).toContainEqual(["sandbox.egress_blocked", { step: "app", host: "x.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }]);
  });

  it("starts a fresh app for each attempt, the re-run after an env_flake too, and closes each", async () => {
    let n = 0;
    const h = base({
      runPack: async () => ({ outcome: "pass", detail: { answer: n++ === 0 ? { verdict: "fail", summary: "x", criteria: [{ text: "a", result: "fail" }] } : answer } }),
      decide: async () => cause("env_flake"),
      overrides: async () => ({}),
    });
    const result = await h.runner(h.context);
    expect(result.detail).toMatchObject({ rerun: true });
    expect(h.events.filter((e) => e.startsWith("open"))).toEqual(["open 10", "open 11"]);
    expect(h.events.filter((e) => e === "close")).toHaveLength(2);
  });

  it("ends the stage as env_broken with the app's own detail, and runs no browser, when the app does not come up", async () => {
    const detail = { escalation: "env_broken", envBroken: true, step: "seed", reason: "the seed command exited 3", logTail: "x", options: [] };
    const h = base({ openApp: async () => ({ ok: false, detail }) });
    expect(await h.runner(h.context)).toMatchObject({ outcome: "escalated", detail });
    expect(h.events).toEqual([]);
  });

  it("closes the app when the browser run throws", async () => {
    const h = base({ runPack: async () => { throw new Error("pack crashed"); } });
    await expect(h.runner(h.context)).rejects.toThrow("pack crashed");
    expect(h.events).toEqual(["open 10", "close"]);
  });

  it("is the old behaviour when no start command is set: no app, and the detail says the agent boots its own", async () => {
    const h = base({ policy: async () => parseLunaConfig("") });
    const result = await h.runner(h.context);
    expect(h.events).toEqual(["pack"]);
    expect(result.detail).toMatchObject({ note: expect.stringContaining("verify.e2e.start is not set") });
    expect(result.detail?.preview).toBeUndefined();
  });

  it("hands a repository that has QA targets the machine's choice of the first, and records it as the preview", async () => {
    const h = base({ policy: async () => parseLunaConfig("qa_targets:\n  - name: staging\n    url: https://staging.example.com\n") });
    const result = await h.runner(h.context);
    expect(h.events).toEqual(["pack"]);
    expect(result.detail).toMatchObject({ preview: { kind: "target", url: "https://staging.example.com" } });
  });
});

describe("the e2e stage and a preview", () => {
  const deploy = parseLunaConfig("verify:\n  e2e:\n    deploy:\n      url_pattern: https://{branch}.preview.example.com\n    start:\n      command: npm start\n");
  it("drives the preview the pattern names instead of starting the app, records it, and removes the preview's network", async () => {
    const events: string[] = [];
    const extras: unknown[] = [];
    const runner = e2eRunner({
      runPack: async (_c: StageContext, extra?: unknown) => (events.push("pack"), extras.push(extra), { outcome: "pass", detail: { answer: { verdict: "pass", summary: "ok", criteria: [] } } }),
      detectWeb: async () => true,
      changedFiles: async () => null,
      policy: async () => deploy,
      headCommit: async () => "c".repeat(40),
      openApp: async () => { throw new Error("must not start the app in deploy mode"); },
      openPreview: async (input: { branch: string }) => (events.push(`preview ${input.branch}`), { ok: true as const, target: { name: "preview" as const, baseUrl: "https://x.preview.example.com" }, close: async () => void events.push("close") }),
    } as never);
    const context = { task: { id: "t1", repoPath: "/repo", worktreePath: dir, branch: "task/x" }, stage: "e2e", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
    const result = await runner(context);
    expect(events).toEqual(["preview task/x", "pack", "close"]);
    expect(extras[0]).toMatchObject({ qaTarget: { name: "preview", baseUrl: "https://x.preview.example.com", credential: null } });
    expect((extras[0] as { alsoJoin?: unknown }).alsoJoin).toBeUndefined();
    expect(result.detail).toMatchObject({ preview: { kind: "deploy", url: "https://x.preview.example.com" } });
  });
});
