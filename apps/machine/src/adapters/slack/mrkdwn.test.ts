import { describe, expect, it } from "vitest";

import { toPlainText } from "./mrkdwn.ts";

describe("toPlainText", () => {
  const names = (id: string) => ({ U1: "higor", U2: "marta" })[id];

  it("names users through the resolver, or keeps the label or id", () => {
    expect(toPlainText("<@U1> ping <@U2|marta-s> <@U9>", names)).toBe("@higor ping @marta-s @U9");
  });

  it("turns channels, usergroups and broadcasts into handles", () => {
    expect(toPlainText("in <#C1|eng> ask <!subteam^S1|@platform> and <!subteam^S2|data> or <!here> <!channel|@channel> <!everyone>")).toBe(
      "in #eng ask @platform and @data or @here @channel @everyone",
    );
    expect(toPlainText("<#C1> <!subteam^S9>")).toBe("#C1 @S9");
  });

  it("keeps a link's label, or its url without one, and unescapes", () => {
    expect(toPlainText("see <https://github.com/o/a/pull/1|PR #1> and <https://x.y> &amp; a &lt;b&gt;")).toBe("see PR #1 and https://x.y & a <b>");
    expect(toPlainText("<mailto:a@b.c|mail me>")).toBe("mail me");
  });

  it("uses a date token's fallback text", () => {
    expect(toPlainText("due <!date^1730000000^{date_short}|Oct 27>")).toBe("due Oct 27");
  });
});
