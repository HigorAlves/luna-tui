import type { PackRunsPort } from "../../application/pack-runs.ts";
import { RunFailedError } from "../../application/pack-runs.ts";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

// A real folder: the routes resolve the repo by real path, as /ticket-chat does.
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "design-routes-")));
const spec = { frames: [{ id: "12:34", name: "Checkout", viewport: null, states: [] }], tokens: { color: [], type: [], spacing: [], radius: [] }, components: [], a11yNotes: [], missing: [], confidence: 0.8 };
const judgedTrap = { criterion: "2.1.2", level: "A", source: "judged", rule: null, impact: null, page: "/checkout", state: "modal", selector: "div.modal", summary: "trap", evidence: [], fix: null, confidence: 0.9 };
const LINK = "https://www.figma.com/design/AbCdEf0123456789/Shop?node-id=12-34";
const staging = { name: "staging", baseUrl: "https://staging.example.com", credential: "env:QA_PASSWORD" };

function appUnderTest(opts: { repos?: string[]; design?: Record<string, unknown>; qaTargets?: Record<string, unknown[]>; answer?: Record<string, unknown> | Error; qaImage?: boolean; agents?: boolean } = {}) {
  const run = vi.fn(async () => {
    if (opts.answer instanceof Error) throw opts.answer;
    return { answer: opts.answer ?? {}, usage: { model: "m", engine: "claude:opus" as const, turns: 1, durationMs: 1, costUsd: 0 } };
  });
  const runs = { run } as unknown as PackRunsPort;
  const policies = { for: async (repo: string | null) => ({ design: opts.design?.[repo ?? ""], qaTargets: opts.qaTargets?.[repo ?? ""] ?? [] }) } as never;
  const app = createApp({ db: {} as never, pipeline: {} as never, bus: new Bus(), chatRepos: async () => opts.repos ?? [], policies, qaImage: opts.qaImage ?? true, ...(opts.agents === false ? {} : { runs }) });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { runs: { run }, post };
}

describe("POST /design/spec", () => {
  it("runs design_spec on the link's design reference over a copy of the repo, with the bridged tools, and answers the spec", async () => {
    const h = appUnderTest({ repos: [REPO], answer: spec });
    const res = await h.post("/design/spec", { repo: REPO, link: LINK });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "spec", ref: { refs: [{ fileKey: "AbCdEf0123456789", nodeIds: ["12:34"], page: null, from: "link" }] }, spec });
    expect(h.runs.run).toHaveBeenCalledWith({ pack: "design_spec", context: { design: { refs: [expect.objectContaining({ from: "link" })] } } }, "board", expect.anything(), { readRepo: REPO, bridge: { repoPath: REPO } });
  });

  it("refuses a link with no Figma reference, a repo it does not know, and a repo with design off", async () => {
    const h = appUnderTest({ repos: [REPO], design: { [REPO]: "off" } });
    const none = await h.post("/design/spec", { repo: REPO, link: "https://example.com/x" });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("no_design_reference");
    expect((await h.post("/design/spec", { repo: "/etc", link: "https://www.figma.com/design/AbCdEf0123456789/x" })).status).toBe(404);
    const off = await h.post("/design/spec", { repo: REPO, link: "https://www.figma.com/design/AbCdEf0123456789/x" });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe("design_off");
    expect(h.runs.run).not.toHaveBeenCalled();
  });

  it("answers 502 design_failed when the run fails, and 503 when agents are off", async () => {
    expect((await appUnderTest({ repos: [REPO], answer: new RunFailedError("boom") }).post("/design/spec", { repo: REPO, link: LINK })).status).toBe(502);
    expect((await appUnderTest({ repos: [REPO], agents: false }).post("/design/spec", { repo: REPO, link: LINK })).status).toBe(503);
  });
});

describe("POST /design/audit", () => {
  it("runs a11y_audit on the named QA target, in the QA image, and answers findings at the repo's level", async () => {
    const h = appUnderTest({ repos: [REPO], qaTargets: { [REPO]: [staging] }, answer: { summary: "s", pages: [], findings: [judgedTrap] } });
    const res = await h.post("/design/audit", { repo: REPO, target: "staging" });
    expect(await res.json()).toMatchObject({ kind: "audit", target: "staging", level: "AA", mode: "gate", findings: [expect.objectContaining({ severity: "blocker", category: "accessibility" })] });
    expect(h.runs.run).toHaveBeenCalledWith({ pack: "a11y_audit", context: { a11y: { level: "AA" } } }, "board", expect.anything(), { readRepo: REPO, qa: { repoPath: REPO, target: staging } });
  });

  it("refuses a target the repo does not declare, a missing QA image, and a repo with design off", async () => {
    const declared = { repos: [REPO], qaTargets: { [REPO]: [staging] } };
    expect((await appUnderTest({ repos: [REPO], qaTargets: { [REPO]: [] } }).post("/design/audit", { repo: REPO, target: "prod" })).status).toBe(404);
    const noImage = await appUnderTest({ ...declared, qaImage: false }).post("/design/audit", { repo: REPO, target: "staging" });
    expect(noImage.status).toBe(503);
    expect((await noImage.json()).error).toBe("qa_image_missing");
    expect((await appUnderTest({ ...declared, design: { [REPO]: "off" } }).post("/design/audit", { repo: REPO, target: "staging" })).status).toBe(409);
  });
});

it("refuses both packs through POST /runs, naming their routes", async () => {
  const h = appUnderTest({});
  const spec = await h.post("/runs", { pack: "design_spec", context: {} });
  expect(spec.status).toBe(400);
  expect((await spec.json()).message).toContain("POST /design/spec");
  const audit = await h.post("/runs", { pack: "a11y_audit", context: {} });
  expect(audit.status).toBe(400);
  expect((await audit.json()).message).toContain("POST /design/audit");
  expect(h.runs.run).not.toHaveBeenCalled();
});
