import { FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type Located, fastLane, ownersCheck } from "./fast-lane.ts";

const config = FACTORY_DEFAULTS.fast_lane;
const ok = { riskPrelim: "low", size: "S", typeOfWork: "backend" } as const;
const sure = { risk: { verdict: "proceed" }, size: { verdict: "proceed" } } as const;
const one = { owners: "one_team" } as const;
const cross = { owners: "cross_team", teams: 2 } as const;
const unchecked = { owners: "not_checked", reason: "no code graph" } as const;

describe("fastLane", () => {
  it("is taken when every condition holds", () => {
    expect(fastLane(ok, one, config, sure)).toEqual({ fast: true });
    expect(fastLane({ ...ok, size: "XS" }, one, config, sure)).toEqual({ fast: true });
  });

  it("names each failing condition in turn", () => {
    expect(fastLane({ ...ok, riskPrelim: "medium" }, one, config, sure)).toEqual({ fast: false, failing: "preliminary risk is medium, above low" });
    expect(fastLane({ ...ok, size: "M" }, one, config, sure)).toEqual({ fast: false, failing: "size is M, above S" });
    expect(fastLane({ ...ok, typeOfWork: "infra" }, one, config, sure)).toMatchObject({ fast: false, failing: expect.stringContaining("infra") });
    expect(fastLane({ ...ok, typeOfWork: "data" }, one, config, sure)).toMatchObject({ fast: false });
    expect(fastLane(ok, cross, config, sure)).toEqual({ fast: false, failing: "the change reaches 2 owning teams" });
    expect(fastLane(ok, one, config, { ...sure, risk: { verdict: "flag" } })).toMatchObject({ fast: false, failing: expect.stringContaining("signal") });
    expect(fastLane(ok, one, config, { ...sure, size: { verdict: "ask" } })).toMatchObject({ fast: false });
  });

  it("keeps the lane when the owners could not be checked, and says why so the plan gate can list it", () => {
    expect(fastLane(ok, unchecked, config, sure)).toEqual({ fast: true, ownersNotChecked: "no code graph" });
  });

  it("takes the repo's limits and its cross-team switch", () => {
    expect(fastLane({ ...ok, riskPrelim: "medium", size: "M" }, one, { ...config, max_risk: "medium", max_size: "M" }, sure)).toEqual({ fast: true });
    expect(fastLane({ ...ok, typeOfWork: "infra" }, one, { ...config, excluded_types: [] }, sure)).toEqual({ fast: true });
    expect(fastLane(ok, cross, { ...config, cross_team: true }, sure)).toEqual({ fast: true });
  });

  it("is never fast for a record with no risk, size or type", () => {
    expect(fastLane({}, one, config, sure)).toMatchObject({ fast: false });
    expect(fastLane({ riskPrelim: "low", size: "S" }, one, config, sure)).toMatchObject({ fast: false });
  });
});

describe("ownersCheck", () => {
  const found = (over: Partial<Exclude<Located, null | "failed">> = {}): Located => ({ files: ["a.ts", "b.ts"], owners: [{ path: "a.ts", owners: ["@acme/cart"] }, { path: "b.ts", owners: ["@acme/cart"] }], stale: false, behind: 3, codeowners: true, ...over });

  it("is one team when every located file has the same owners, and when none has any", () => {
    expect(ownersCheck(found())).toEqual({ owners: "one_team" });
    expect(ownersCheck(found({ owners: [] }))).toEqual({ owners: "one_team" });
  });

  it("is cross team when the files reach two owners", () => {
    expect(ownersCheck(found({ owners: [{ path: "a.ts", owners: ["@acme/cart"] }, { path: "b.ts", owners: ["@acme/auth"] }] }))).toEqual({ owners: "cross_team", teams: 2 });
  });

  it("is not checked, with the reason, for no graph, a failed call, a stale graph, no matching file and no CODEOWNERS", () => {
    expect(ownersCheck(null)).toEqual({ owners: "not_checked", reason: "no code graph" });
    expect(ownersCheck("failed")).toEqual({ owners: "not_checked", reason: "the code graph could not be asked" });
    expect(ownersCheck(found({ stale: true, behind: 51 }))).toEqual({ owners: "not_checked", reason: "the code graph is stale (51 commits behind)" });
    expect(ownersCheck(found({ files: [], owners: [] }))).toEqual({ owners: "not_checked", reason: "no file matched the card's words" });
    expect(ownersCheck(found({ codeowners: false, owners: [] }))).toEqual({ owners: "not_checked", reason: "the repository has no CODEOWNERS" });
  });
});
