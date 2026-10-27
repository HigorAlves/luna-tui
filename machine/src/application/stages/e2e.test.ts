import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(result).toEqual({ outcome: "pass", detail: { step: "e2e", skipped: true, reason: "PIPELINE.md says qa: none" } });
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
