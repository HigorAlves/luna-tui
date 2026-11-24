import type { EvidencePack } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { evidenceView } from "./conversation-evidence.ts";

const pack = (over: Record<string, unknown> = {}): EvidencePack => ({
  summary: "Checkout retries three times\nwhen the payment fails.", format: "text",
  scenarios: [{ text: "retries", test: "t.test.ts", result: "pass" }, { text: "gives up", test: null, result: "pass" }, { text: "logs", test: null, result: "fail" }],
  findings: ["FINDING-TEXT-SECRET"], outOfMap: ["OUT-OF-MAP-PATH"], risk: "low", rollback: "ROLLBACK-STEPS", howToVerify: "VERIFY-STEPS", commitSha: "deadbeefcafe",
  media: [{ kind: "video", label: "LABEL-X", url: "https://media.example/v.mp4", localPath: "/Users/me/secret/v.mp4" }],
  video: { file: "/Users/me/secret/walk.mp4", durationS: 3, verdict: "ship", scores: {}, defects: ["DEFECT-TEXT"], rounds: 1 },
  ...over,
}) as unknown as EvidencePack;

describe("evidenceView", () => {
  it("keeps the summary, the format and the result counts, flattened", () => {
    expect(evidenceView(pack())).toBe("Summary: Checkout retries three times when the payment fails. Format: text. Results: 2 pass, 1 fail, 0 partial, 0 skipped.");
  });
  it("never lets a field outside the allowlist reach the text", () => {
    const text = evidenceView(pack())!;
    for (const leaked of ["FINDING-TEXT-SECRET", "OUT-OF-MAP-PATH", "ROLLBACK-STEPS", "VERIFY-STEPS", "deadbeef", "LABEL-X", "media.example", "/Users/me", "DEFECT-TEXT"]) expect(text).not.toContain(leaked);
  });
  it("caps the summary, and masks personal data in it", () => {
    const text = evidenceView(pack({ summary: `write to ana@corp.example ${"y".repeat(2000)}` }));
    expect(text).not.toContain("ana@corp.example");
    expect(text!.length).toBeLessThan(900);
  });
  it("is null with no pack", () => {
    expect(evidenceView(null)).toBeNull();
  });
});
