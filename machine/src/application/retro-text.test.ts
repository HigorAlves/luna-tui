import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { inert, proposalsSection } from "./retro-text.ts";

describe("proposalsSection", () => {
  it("is an inert Proposals section: no mentions, no markup, nothing past the caps", () => {
    const text = proposalsSection([{ kind: "adr", title: "Use <b>queues</b> @bo", body: "see #12 and @team " + "y".repeat(3000) }]);
    expect(text).toMatch(/^## Proposals/);
    expect(text).not.toContain("<b>");
    expect(text).not.toMatch(/@(?=[A-Za-z])/);
    expect(text.length).toBeLessThan(2600);
  });
  it("is empty with no proposals", () => {
    expect(proposalsSection([])).toBe("");
  });
});

describe("inert", () => {
  it("escapes markup and neutralizes mentions and issue references", () => {
    const out = inert("<!-- x --> @bo closes #12");
    expect(out).not.toContain("<");
    expect(out).not.toMatch(/@(?=[A-Za-z])/);
    expect(out).not.toMatch(/#(?=\d)/);
  });
});

describe("the retro's modules do not import each other", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const imports = (file: string) => readFileSync(join(here, file), "utf8");
  it("close-task.ts takes the shared helpers from retro-text.ts; neither it nor retro-outputs.ts imports the other", () => {
    expect(imports("retro-outputs.ts")).not.toContain("close-task.ts");
    expect(imports("close-task.ts")).not.toContain("retro-outputs.ts");
    expect(imports("close-task.ts")).toContain("retro-text.ts");
  });
});
