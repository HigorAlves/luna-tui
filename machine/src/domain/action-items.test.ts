import { describe, expect, it } from "vitest";

import { actionItemsOf } from "./action-items.ts";

const page = (items: string) => `# Postmortem: Checkout failing\n\n## Summary\n\n- [ ] not an item here\n\n## Action items\n\n${items}\n`;

describe("actionItemsOf", () => {
  it("reads each unchecked box of the Action items section, with its owner and due date", () => {
    expect(actionItemsOf(page("- [ ] Add a check (owner: platform, due: 2026-12-01)\n- [ ] Alert on public buckets (owner: unassigned, due: none)\n- [ ] Plain item"))).toEqual([
      { title: "Add a check", owner: "platform", due: "2026-12-01" },
      { title: "Alert on public buckets", owner: null, due: null },
      { title: "Plain item", owner: null, due: null },
    ]);
  });

  it("keeps a title that has parentheses of its own", () => {
    expect(actionItemsOf(page("- [ ] Rotate the key (the old one) now (owner: ana, due: 2026-12-05)"))).toEqual([{ title: "Rotate the key (the old one) now", owner: "ana", due: "2026-12-05" }]);
  });

  it("skips a ticked box, other bullets, and blank titles", () => {
    expect(actionItemsOf(page("- [x] Done already (owner: ana, due: none)\n- A note\n- [ ]   \n* [ ] Star bullet"))).toEqual([{ title: "Star bullet", owner: null, due: null }]);
  });

  it("stops at the next heading and finds the section whatever its case", () => {
    expect(actionItemsOf("## action ITEMS\n\n- [ ] One\n\n## After\n\n- [ ] Two\n")).toEqual([{ title: "One", owner: null, due: null }]);
  });

  it("is empty when there is no such section or it says None", () => {
    expect(actionItemsOf("# T\n\n## Summary\n\ntext\n")).toEqual([]);
    expect(actionItemsOf(page("None."))).toEqual([]);
  });
});
