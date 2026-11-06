import { describe, expect, it } from "vitest";

import { previewUrlOf } from "./preview-url.ts";

const ids = { branch: "task/Fix-The_Cart", sha: "a".repeat(40), card: "ABCD1234-0000-1111" };
const url = (pattern: string, over: Partial<typeof ids> = {}) => previewUrlOf(pattern, { ...ids, ...over });

describe("previewUrlOf", () => {
  it("fills {branch} (lowercased, runs outside a-z0-9 become -, cut at 63), {sha}, {short_sha} and {card}", () => {
    expect(url("https://{branch}.preview.example.com")).toEqual({ ok: true, url: "https://task-fix-the-cart.preview.example.com" });
    expect(url("https://{short_sha}-{card}.example.com/app")).toEqual({ ok: true, url: `https://aaaaaaa-abcd1234-0000-1111.example.com/app` });
    expect(url("https://x.example.com/{sha}")).toEqual({ ok: true, url: `https://x.example.com/${"a".repeat(40)}` });
    const long = url("https://{branch}.example.com", { branch: "b".repeat(100) });
    expect(long.ok && long.url).toBe(`https://${"b".repeat(63)}.example.com`);
  });

  it("cannot be moved off the pattern's host by a branch named to do it", () => {
    for (const branch of ["x.evil.example/", "x@evil.example", "a.b.c.d", "../../x", "x%2f.evil.example", "x\\evil.example", "evil.example:8080", "xn--evil", "-", "////"]) {
      const out = url("https://{branch}.preview.example.com/app", { branch });
      if (out.ok) {
        const host = new URL(out.url).hostname;
        expect(host.endsWith(".preview.example.com"), `${branch} -> ${out.url}`).toBe(true);
        expect(host.split(".").length, out.url).toBe(4);
        expect(new URL(out.url).username).toBe("");
        expect(new URL(out.url).port).toBe("");
      } else expect(out.reason).toBeTruthy();
    }
  });

  it("refuses a result that is not an https URL on a valid host with the same last two labels", () => {
    expect(url("http://{branch}.example.com").ok).toBe(false);
    expect(url("https://{branch}.example.com", { branch: "///" }).ok).toBe(false);
    expect(url("https://{card}", { card: "1" }).ok).toBe(false);
    expect(url("https://{branch}.com").ok).toBe(false);
  });
});
