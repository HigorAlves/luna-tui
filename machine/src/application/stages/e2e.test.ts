import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Learned } from "../decision-truth.ts";
import { tagged } from "../decision-truth.ts";
import type { Decide } from "./check-decide.ts";
import { detectWeb, e2eRunner, missingQaImageRunner, touchesRenderedSurface, webRoots } from "./e2e.ts";
import type { StageContext, StageResult } from "../ports.ts";

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
