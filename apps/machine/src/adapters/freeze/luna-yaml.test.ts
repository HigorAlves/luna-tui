import { describe, expect, it } from "vitest";

import { noFreezeSource } from "../../application/freeze.ts";
import { lunaYamlFreeze } from "./luna-yaml.ts";

describe("the freeze source", () => {
  it("answers none for noFreezeSource", async () => expect(await noFreezeSource().windows("/repo")).toEqual([]));

  it("reads freeze[] from the repository's policy, for that repository", async () => {
    const asked: Array<string | null> = [];
    const window = { from: "2026-11-04T00:00:00Z", to: "2026-11-05T00:00:00Z", reason: "release week" };
    const source = lunaYamlFreeze({ for: async (repo) => (asked.push(repo), { freeze: [window] }) as never });
    expect(await source.windows("/repo")).toEqual([window]);
    expect(asked).toEqual(["/repo"]);
  });
});
