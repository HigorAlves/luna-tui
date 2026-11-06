import { describe, expect, it } from "vitest";

import type { CanonicalMessage } from "@hardness/contracts";

import { humansActive } from "./conversation-quiet.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const msg = (author: string, minutesAgo: number, isBot = false): CanonicalMessage => ({ id: `${author}${minutesAgo}`, author: { id: author, name: author, isBot }, text: "x", ts: String((NOW.getTime() - minutesAgo * 60_000) / 1000), editedAt: null, deleted: false } as unknown as CanonicalMessage);

describe("humansActive", () => {
  it("is true when another person replied inside the window", () => {
    expect(humansActive([msg("U2", 30), msg("U3", 4)], "U1", NOW, 10)).toBe(true);
  });
  it("ignores the person's own messages, bots and replies outside the window", () => {
    expect(humansActive([msg("U1", 2)], "U1", NOW, 10)).toBe(false);
    expect(humansActive([msg("B1", 2, true)], "U1", NOW, 10)).toBe(false);
    expect(humansActive([msg("U3", 11)], "U1", NOW, 10)).toBe(false);
  });
  it("does not count the first message of the thread, only replies after it", () => {
    expect(humansActive([msg("U2", 3)], "U1", NOW, 10)).toBe(false);
    expect(humansActive([msg("U2", 30), msg("U2", 3)], "U1", NOW, 10)).toBe(true);
  });
});
