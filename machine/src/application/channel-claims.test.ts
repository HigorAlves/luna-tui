import { FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { ChannelClaims } from "./channel-claims.ts";

const claims = (byRepo: Record<string, string[]>) =>
  new ChannelClaims(
    async () => Object.keys(byRepo),
    async (repo) => ({ conversation: { ...FACTORY_DEFAULTS.conversation, channels: byRepo[repo] ?? [], debounce_seconds: repo === "/r/a" ? 5 : 90 }, scoring: FACTORY_DEFAULTS.scoring }),
  );

describe("ChannelClaims", () => {
  it("answers the one repository whose luna.yaml lists the channel", async () => {
    const c = claims({ "/r/a": ["C1", "C2"], "/r/b": ["C3"] });
    await c.refresh();
    expect(c.repoOf("C1")).toBe("/r/a");
    expect(c.repoOf("C3")).toBe("/r/b");
    expect(c.repoOf("C9")).toBeNull();
    expect([...c.claimed()].sort()).toEqual(["C1", "C2", "C3"]);
  });
  it("answers null for a channel two repositories list, which is still claimed", async () => {
    const c = claims({ "/r/a": ["C1"], "/r/b": ["C1"] });
    await c.refresh();
    expect(c.repoOf("C1")).toBeNull();
    expect(c.claimed().has("C1")).toBe(true);
  });
  it("gives a conversation the claiming repository's section, else the defaults", async () => {
    const c = claims({ "/r/a": ["C1"] });
    await c.refresh();
    expect(c.configOf("C1").conversation.debounce_seconds).toBe(5);
    expect(c.configOf("C9").conversation).toEqual(FACTORY_DEFAULTS.conversation);
  });
  it("keeps what it knew when a repository's file cannot be read", async () => {
    let fail = false;
    const c = new ChannelClaims(
      async () => ["/r/a"],
      async () => {
        if (fail) throw new Error("gone");
        return { conversation: { ...FACTORY_DEFAULTS.conversation, channels: ["C1"] }, scoring: FACTORY_DEFAULTS.scoring };
      },
    );
    await c.refresh();
    fail = true;
    await c.refresh();
    expect(c.repoOf("C1")).toBe("/r/a");
  });
});
