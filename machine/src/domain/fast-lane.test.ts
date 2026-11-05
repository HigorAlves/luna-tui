import { FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { fastLane } from "./fast-lane.ts";

const config = FACTORY_DEFAULTS.fast_lane;
const ok = { riskPrelim: "low", size: "S", typeOfWork: "backend" } as const;
const sure = { risk: { verdict: "proceed" }, size: { verdict: "proceed" } } as const;
const one = [{ path: "a.ts", owners: ["@acme/cart"] }, { path: "b.ts", owners: ["@acme/cart"] }];

describe("fastLane", () => {
  it("is taken when every condition holds", () => {
    expect(fastLane(ok, one, config, sure)).toEqual({ fast: true });
    expect(fastLane({ ...ok, size: "XS" }, [], config, sure)).toEqual({ fast: true });
  });

  it("names each failing condition in turn", () => {
    expect(fastLane({ ...ok, riskPrelim: "medium" }, one, config, sure)).toEqual({ fast: false, failing: "preliminary risk is medium, above low" });
    expect(fastLane({ ...ok, size: "M" }, one, config, sure)).toEqual({ fast: false, failing: "size is M, above S" });
    expect(fastLane({ ...ok, typeOfWork: "infra" }, one, config, sure)).toMatchObject({ fast: false, failing: expect.stringContaining("infra") });
    expect(fastLane({ ...ok, typeOfWork: "data" }, one, config, sure)).toMatchObject({ fast: false });
    expect(fastLane(ok, [{ path: "a", owners: ["@acme/cart"] }, { path: "b", owners: ["@acme/auth"] }], config, sure)).toEqual({ fast: false, failing: "the change reaches 2 owning teams" });
    expect(fastLane(ok, one, config, { ...sure, risk: { verdict: "flag" } })).toMatchObject({ fast: false, failing: expect.stringContaining("signal") });
    expect(fastLane(ok, one, config, { ...sure, size: { verdict: "ask" } })).toMatchObject({ fast: false });
  });

  it("skips the owners condition without a graph, and says so", () => {
    expect(fastLane(ok, null, config, sure)).toEqual({ fast: true, skipped: "no code graph: the owning-team condition was not checked" });
  });

  it("takes the repo's limits and its cross-team switch", () => {
    expect(fastLane({ ...ok, riskPrelim: "medium", size: "M" }, one, { ...config, max_risk: "medium", max_size: "M" }, sure)).toEqual({ fast: true });
    expect(fastLane({ ...ok, typeOfWork: "infra" }, one, { ...config, excluded_types: [] }, sure)).toEqual({ fast: true });
    const two = [{ path: "a", owners: ["@a/x", "@a/y"] }];
    expect(fastLane(ok, two, { ...config, cross_team: true }, sure)).toEqual({ fast: true });
  });

  it("is never fast for a record with no risk, size or type", () => {
    expect(fastLane({}, one, config, sure)).toMatchObject({ fast: false });
    expect(fastLane({ riskPrelim: "low", size: "S" }, one, config, sure)).toMatchObject({ fast: false });
  });
});
