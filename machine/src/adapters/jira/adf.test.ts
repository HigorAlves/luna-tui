import { describe, expect, it } from "vitest";

import { adfToMarkdown, markdownToAdf } from "./adf.ts";

const text = (value: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });

describe("adfToMarkdown", () => {
  it("renders paragraphs, headings, lists, code blocks, links, cards and marks; unknown nodes keep their text", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Login page")] },
        paragraph(text("Users sign in with "), text("email", [{ type: "strong" }]), text(" and a "), text("password", [{ type: "code" }]), text(".")),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("bad password shows an error"))] },
            { type: "listItem", content: [paragraph(text("see ")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("nested"))] }] }] },
          ],
        },
        { type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("first"))] }, { type: "listItem", content: [paragraph(text("second"))] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
        paragraph(text("Spec: "), text("the doc", [{ type: "link", attrs: { href: "https://wiki/x" } }]), text(" and "), { type: "inlineCard", attrs: { url: "https://github.com/o/a/pull/7" } }),
        { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("mind the gap"))] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] },
        { type: "unknownThing", content: [text("kept as text")] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      [
        "## Login page",
        "",
        "Users sign in with **email** and a `password`.",
        "",
        "- bad password shows an error",
        "- see ",
        "  - nested",
        "",
        "1. first",
        "2. second",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "Spec: [the doc](https://wiki/x) and [https://github.com/o/a/pull/7](https://github.com/o/a/pull/7)",
        "",
        "mind the gap",
        "",
        "(attachment)",
        "",
        "kept as text",
      ].join("\n"),
    );
  });

  it("passes a string through and gives an empty string for nothing", () => {
    expect(adfToMarkdown("already text")).toBe("already text");
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ type: "doc", version: 1, content: [] })).toBe("");
  });
});

describe("markdownToAdf", () => {
  it("builds paragraphs from blank-line blocks, bullets from `- ` lines and links from bare urls", () => {
    const doc = markdownToAdf("Picked up as task #a1b2c3d4 on the Luna board.\n\nPR opened: https://github.com/o/a/pull/7.\n\n## Criteria\n- [x] bad password shows an error\n- login works\n\nDone.");
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        paragraph(text("Picked up as task #a1b2c3d4 on the Luna board.")),
        paragraph(text("PR opened: "), text("https://github.com/o/a/pull/7", [{ type: "link", attrs: { href: "https://github.com/o/a/pull/7" } }]), text(".")),
        { type: "heading", attrs: { level: 2 }, content: [text("Criteria")] },
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("[x] bad password shows an error"))] }, { type: "listItem", content: [paragraph(text("login works"))] }] },
        paragraph(text("Done.")),
      ],
    });
  });

  it("round-trips through adfToMarkdown and never leaves an empty document", () => {
    const md = "First line\n\n- one\n- two https://x.y/z\n\nLast";
    expect(adfToMarkdown(markdownToAdf(md))).toBe("First line\n\n- one\n- two [https://x.y/z](https://x.y/z)\n\nLast");
    expect(markdownToAdf("").content).toEqual([paragraph(text(""))]);
  });
});
