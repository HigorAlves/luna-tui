import { describe, expect, it } from "vitest";

import { HISTORY_ENTRIES, historyOf } from "./card-history.ts";

describe("the history a card keeps of its sources", () => {
  it("flattens and caps each entry and keeps at most fifty", () => {
    const raw = Array.from({ length: 80 }, (_, i) => ({ author: `u${i}`, text: `line ${i}\n# not a heading ${"x".repeat(900)}` }));
    const kept = historyOf(raw);
    expect(kept).toHaveLength(HISTORY_ENTRIES);
    expect(kept[0]!.author).toBe("u0");
    expect(kept[0]!.text).not.toContain("\n");
    expect(kept[0]!.text.length).toBeLessThanOrEqual(500);
  });

  it("leaves no markup, mention or token in an entry", () => {
    const token = ["gh", "p_"].join("") + "a".repeat(36);
    const [entry] = historyOf([{ author: "<b>eve</b>", text: `<script>x</script> @channel see ${token}` }]);
    expect(entry!.author).not.toContain("<");
    expect(entry!.text).not.toContain("<");
    expect(entry!.text).not.toContain(token);
    expect(entry!.text).not.toContain("@channel");
  });
});
