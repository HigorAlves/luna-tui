import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { scenariosKeyOf, staleParts, touchesRenderedSurface } from "./evidence-stale.ts";

const pack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  summary: "s", format: "video", scenarios: [{ text: "a", test: null, result: "pass" }], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "aaa1111", media: [], at: "2026-11-04T00:00:00.000Z",
  source: { e2eRunId: "run-1", scenariosKey: "key-1", stepsSha: "steps-1" },
  ...over,
});
const now = (over: Partial<Parameters<typeof staleParts>[1]> = {}) => ({ e2eRunId: "run-1", scenariosKey: "key-1", stepsSha: "steps-1", results: ["pass"], changedPaths: ["server/db.ts"], ...over });

describe("staleParts", () => {
  it("the text is always stale; with nothing else changed the captures and the film are kept", () => {
    expect(staleParts(pack(), now())).toEqual(["text"]);
  });

  it("the captures are not listed as stale: nothing is redone for them (the stage always takes the latest run's screenshots)", () => {
    expect(staleParts(pack(), now({ e2eRunId: "run-2" }))).toEqual(["text"]);
    expect(staleParts(pack(), now({ e2eRunId: "run-2", results: ["fail"] }))).not.toContain("captures");
  });

  it("the film is stale when the scenarios changed", () => {
    expect(staleParts(pack(), now({ scenariosKey: "key-2" }))).toEqual(["text", "film"]);
  });

  it("the film is stale when a newer browser run changed a scenario's result or the steps", () => {
    expect(staleParts(pack(), now({ e2eRunId: "run-2", results: ["fail"] }))).toEqual(["text", "film"]);
    expect(staleParts(pack(), now({ e2eRunId: "run-2", stepsSha: "steps-2" }))).toEqual(["text", "film"]);
    // a newer run that proved the same thing leaves the film alone
    expect(staleParts(pack(), now({ e2eRunId: "run-2" }))).not.toContain("film");
  });

  it("the film is stale when the paths changed between the commits touch a rendered surface, and unknown paths count as touching", () => {
    expect(staleParts(pack(), now({ changedPaths: ["web/cart.tsx"] }))).toEqual(["text", "film"]);
    expect(staleParts(pack(), now({ changedPaths: null }))).toEqual(["text", "film"]);
  });

  it("a pack with no source has its text and its film made again", () => {
    const { source: _, ...bare } = pack();
    expect(staleParts(bare as EvidencePack, now())).toEqual(["text", "film"]);
    expect(staleParts(null, now())).toEqual(["text", "film"]);
  });
});

describe("touchesRenderedSurface", () => {
  it("is true for markup, styles, components and public assets, false for server code and docs", () => {
    for (const p of ["web/cart.tsx", "src/App.vue", "styles/main.css", "public/logo.png", "app/page.jsx", "index.html"]) expect(touchesRenderedSurface([p]), p).toBe(true);
    for (const p of ["server/db.ts", "docs/readme.md", "migrations/001.sql", "package.json"]) expect(touchesRenderedSurface([p]), p).toBe(false);
    expect(touchesRenderedSurface([])).toBe(false);
  });
});

describe("scenariosKeyOf", () => {
  it("is the same for the same ids and titles in any call, and differs when a title changes", () => {
    const a = scenariosKeyOf([{ id: "S1", title: "A" }, { id: "S2", title: "B" }]);
    expect(scenariosKeyOf([{ id: "S1", title: "A" }, { id: "S2", title: "B" }])).toBe(a);
    expect(scenariosKeyOf([{ id: "S1", title: "A" }, { id: "S2", title: "C" }])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
