import { describe, expect, it } from "vitest";

import { parityPublishRule, pairsPublished } from "./parity-publish.ts";

describe("whether the frame | build pairs go on the PR (design.parity.publish, RFC 0013)", () => {
  it("publishes on `always`, whatever the repo is", () => {
    expect(pairsPublished("always", false)).toBe(true);
    expect(pairsPublished("always", null)).toBe(true);
  });
  it("never publishes on `never`", () => {
    expect(pairsPublished("never", true)).toBe(false);
  });
  it("on `auto` publishes only for a repository known to be private: unknown is treated as public", () => {
    expect(pairsPublished("auto", true)).toBe(true);
    expect(pairsPublished("auto", false)).toBe(false);
    expect(pairsPublished("auto", null)).toBe(false);
  });
  it("reads the rule from the repo's design config, `auto` by default and for `off`", () => {
    expect(parityPublishRule(undefined)).toBe("auto");
    expect(parityPublishRule("off")).toBe("auto");
    expect(parityPublishRule({})).toBe("auto");
    expect(parityPublishRule({ parity: { publish: "never" } })).toBe("never");
  });
});
