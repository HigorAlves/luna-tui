import { describe, expect, it } from "vitest";

import { isDocsOnly } from "./docs-only.ts";

describe("isDocsOnly", () => {
  it("takes the STE cards' plans: READMEs and docs, with the tests the planner meant to write", () => {
    expect(isDocsOnly([".github/README.md", "board/README.md", "docs/README.md", "evals/README.md"])).toBe(true);
    expect(isDocsOnly(["docs/contributing.md", "contracts/src/core-docs-ste.test.ts", "docs/install.md", "docs/api.md"])).toBe(true);
  });
  it("does not take a plan that touches code, or one with tests only", () => {
    expect(isDocsOnly(["docs/api.md", "machine/src/adapters/http/app.ts"])).toBe(false);
    expect(isDocsOnly(["board/src/ui.rs", "board/src/detail.rs"])).toBe(false);
    expect(isDocsOnly(["contracts/src/readme.test.ts"])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });
});
