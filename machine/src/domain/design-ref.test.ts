import { describe, expect, it } from "vitest";

import { designRefOf, figmaRefsIn } from "./design-ref.ts";

const settings = (figma: { file: string; page: string | null } | null = null) => ({ off: false, figma, budget: { max_tokens: 1_000_000, max_minutes: 45 }, a11y: { level: "AA" as const, mode: "gate" as const } });

describe("figmaRefsIn", () => {
  it("finds design, file and proto links with their node ids, in API form", () => {
    const text = "See https://www.figma.com/design/AbCdEf0123456789/Shop?node-id=12-34&t=x and https://figma.com/proto/AbCdEf0123456789/Shop?node-id=5%3A6";
    expect(figmaRefsIn(text, "issue")).toEqual([{ fileKey: "AbCdEf0123456789", nodeIds: ["12:34", "5:6"], page: null, from: "issue" }]);
  });
  it("keeps a link with no node id as the whole file", () => {
    expect(figmaRefsIn("https://www.figma.com/file/ZyXwVu9876543210/Old", "attachment")).toEqual([{ fileKey: "ZyXwVu9876543210", nodeIds: [], page: null, from: "attachment" }]);
  });
  it("ignores hosts that only look like Figma, and node ids that are not ids", () => {
    expect(figmaRefsIn("https://www.figma.com.evil.dev/design/AbCdEf0123456789/x https://notfigma.com/design/AbCdEf0123456789/x", "issue")).toEqual([]);
    expect(figmaRefsIn("https://www.figma.com/design/AbCdEf0123456789/x?node-id=<script>", "issue")[0]!.nodeIds).toEqual([]);
  });
  it("keeps at most five files and twenty nodes each", () => {
    const many = Array.from({ length: 7 }, (_, i) => `https://www.figma.com/design/File${i}abcdefghij/x`).join(" ");
    expect(figmaRefsIn(many, "issue")).toHaveLength(5);
    const nodes = Array.from({ length: 25 }, (_, i) => `https://www.figma.com/design/AbCdEf0123456789/x?node-id=${i + 1}-1`).join(" ");
    expect(figmaRefsIn(nodes, "issue")[0]!.nodeIds).toHaveLength(20);
  });
});

describe("designRefOf", () => {
  it("takes the on-demand link first, then the card's text, then attachments, then luna.yaml", () => {
    const link = "https://www.figma.com/design/LinkKey0123456789/x?node-id=1-2";
    const text = "https://www.figma.com/design/TextKey0123456789/x";
    const attachments = [{ name: "mock", url: "https://www.figma.com/design/AttachKey012345/x" }];
    expect(designRefOf({ link, text, attachments, settings: settings() })!.refs[0]!.from).toBe("link");
    expect(designRefOf({ text, attachments, settings: settings() })!.refs.map((r) => r.from)).toEqual(["issue", "attachment"]);
    expect(designRefOf({ text: "no link", attachments: [], settings: settings({ file: "YamlKey0123456789", page: "Checkout" }) })).toEqual({ refs: [{ fileKey: "YamlKey0123456789", nodeIds: [], page: "Checkout", from: "luna.yaml" }] });
    expect(designRefOf({ text: "no link", attachments: [], settings: settings() })).toBeNull();
  });
  it("merges the node ids of one file named by several sources, first source's origin kept, twenty at most", () => {
    const link = "https://www.figma.com/design/AbCdEf0123456789/x?node-id=1-2";
    const text = "https://www.figma.com/design/AbCdEf0123456789/x?node-id=3-4 https://www.figma.com/design/AbCdEf0123456789/x?node-id=1-2";
    const attachments = [{ name: "mock", url: "https://www.figma.com/design/AbCdEf0123456789/x?node-id=5-6" }];
    expect(designRefOf({ link, text, attachments, settings: settings() })!.refs).toEqual([{ fileKey: "AbCdEf0123456789", nodeIds: ["1:2", "3:4", "5:6"], page: null, from: "link" }]);
    const many = Array.from({ length: 15 }, (_, i) => `https://www.figma.com/design/AbCdEf0123456789/x?node-id=${i + 1}-1`);
    const refs = designRefOf({ text: many.slice(0, 15).join(" "), attachments: many.map((url, i) => ({ name: `m${i}`, url: url.replace("-1", "-2") })), settings: settings() })!.refs;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.nodeIds).toHaveLength(20);
  });
  it("gives nothing when the repo turned design off", () => {
    expect(designRefOf({ text: "https://www.figma.com/design/TextKey0123456789/x", attachments: [], settings: { ...settings(), off: true } })).toBeNull();
  });
});
