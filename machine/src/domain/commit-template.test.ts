import { describe, expect, it } from "vitest";

import { renderCommitTemplate } from "./commit-template.ts";

const vars = { title: "Export CSV", number: 12, card: "ab12cd34", risk: "low", url: "https://github.com/o/a/pull/12" };

describe("renderCommitTemplate", () => {
  it("fills the five placeholders; the first line is the commit title, the rest the message", () => {
    const out = renderCommitTemplate("{{title}} ({{risk}})\n\nCard {{card}}, PR {{number}}", vars);
    expect(out?.title).toBe("Export CSV (low)");
    expect(out?.message).toBe("Card ab12cd34, PR 12");
  });

  it("a null template passes no title and no message", () => {
    expect(renderCommitTemplate(null, vars)).toBeNull();
    expect(renderCommitTemplate("   ", vars)).toBeNull();
  });

  it("an unknown placeholder stays as written, and no field a model wrote is one", () => {
    expect(renderCommitTemplate("{{title}} {{summary}} {{secret}}", vars)?.title).toBe("Export CSV {{summary}} {{secret}}");
  });

  it("flattens each value through safe(): one line, no mention, no issue reference, no autolink", () => {
    const out = renderCommitTemplate("{{title}}", { ...vars, title: "fix @ana Closes #12\nsee https://evil.example/x <b>hi</b>" });
    expect(out?.title).not.toMatch(/\n/);
    expect(out?.title).not.toMatch(/@ana/);
    expect(out?.title).not.toMatch(/#12/);
    expect(out?.title).not.toMatch(/https:\/\//);
    expect(out?.title).not.toMatch(/<b>/);
  });

  it("prints the PR's own address in the open, since the machine built it, and breaks any other", () => {
    expect(renderCommitTemplate("{{url}}", vars)?.title).toBe("https://github.com/o/a/pull/12");
    expect(renderCommitTemplate("{{url}}", { ...vars, url: "https://evil.example/o/a/pull/12" })?.title).not.toMatch(/https:\/\//);
  });

  it("caps the title at 200 characters and the message at 4000", () => {
    const out = renderCommitTemplate(`{{title}}\n${"x".repeat(5000)}`, { ...vars, title: "t".repeat(500) });
    expect(out?.title).toHaveLength(200);
    expect(out?.message).toHaveLength(4000);
  });

  it("a value cannot add a line of its own: the template alone decides where the title ends", () => {
    const out = renderCommitTemplate("{{title}}", { ...vars, title: "one\n\ntwo" });
    expect(out?.message).toBe("");
    expect(out?.title).toBe("one two");
  });
});
