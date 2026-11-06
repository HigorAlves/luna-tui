import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { repoDocs } from "./repo-docs.ts";

const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

describe("repoDocs", () => {
  it("gives the three sections that best match the text, 1500 characters each at most", async () => {
    const dir = repo({
      "README.md": "# App\nintro words\n## Checkout retries\ncheckout retries three times when the payment fails\n## Billing\ninvoices are monthly\n",
      "docs/a.md": `## Export\ncsv export of reports\n${"x ".repeat(2000)}`,
      "docs/b.md": "## Login\nlogin sessions\n## Checkout limits\ncheckout limit is five items\n",
    });
    const out = await repoDocs(dir, "checkout payment fails retries invoices");
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Checkout retries");
    for (const section of out) expect(section.length).toBeLessThanOrEqual(1500);
  });
  it("follows no symlink and skips a file over 256 KB, and reads nothing outside the checkout", async () => {
    const outside = repo({ "secret.md": "## Checkout\nthe outside secret about checkout" });
    const dir = repo({ "README.md": "## Checkout\nplain checkout words", "docs/big.md": `## Checkout\n${"checkout ".repeat(40_000)}` });
    symlinkSync(join(outside, "secret.md"), join(dir, "docs", "link.md"));
    symlinkSync(outside, join(dir, "docs", "linked-dir"));
    const out = (await repoDocs(dir, "checkout")).join("\n");
    expect(out).toContain("plain checkout words");
    expect(out).not.toContain("outside secret");
    expect(out).not.toContain("checkout checkout checkout checkout checkout checkout checkout checkout checkout checkout checkout checkout");
  });
  it("is empty for a missing checkout", async () => {
    expect(await repoDocs("/no/such/dir", "anything")).toEqual([]);
  });
});
