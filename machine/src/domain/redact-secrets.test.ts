import { describe, expect, it } from "vitest";

import { redactDeep, secretRedactor } from "./redact-secrets.ts";

// Secrets are built at runtime, never written as literals.
const v1 = ["pw", "one", "A".repeat(6), "+/="].join("");
const v2 = ["pw", "two", "B".repeat(8)].join("-");

describe("secretRedactor", () => {
  const redact = secretRedactor({ ONE: v1, TWO: v2 });

  it("replaces the value and its base64, base64url, percent-encoded and JSON-escaped forms with the secret's name", () => {
    const b64 = Buffer.from(v1).toString("base64");
    const b64url = Buffer.from(v1).toString("base64url");
    const pct = encodeURIComponent(v1);
    const json = JSON.stringify(`a"b\n${v1}`).slice(1, -1);
    const text = [`plain ${v1}`, `b64 ${b64}`, `b64url ${b64url}`, `pct ${pct}`, `json ${json}`, `two ${v2}`].join("\n");
    const out = redact(text);
    for (const leaked of [v1, v2, b64, b64url, pct]) expect(out).not.toContain(leaked);
    expect(out).toContain("plain [secret:ONE]");
    expect(out).toContain("b64 [secret:ONE]");
    expect(out).toContain("pct [secret:ONE]");
    expect(out).toContain("two [secret:TWO]");
  });

  it("replaces a longer value before a shorter one that it contains", () => {
    const short = "abcdefgh";
    const long = `${short}-and-more`;
    expect(secretRedactor({ SHORT: short, LONG: long })(`x ${long} y ${short}`)).toBe("x [secret:LONG] y [secret:SHORT]");
  });

  it("returns its input for no secret, and leaves text without a value alone", () => {
    const text = "nothing to see";
    expect(secretRedactor({})(text)).toBe(text);
    expect(redact(text)).toBe(text);
  });
});

describe("redactDeep", () => {
  it("redacts every string of a value, keys of objects included, and leaves numbers and nulls", () => {
    const redact = secretRedactor({ ONE: v1 });
    const out = redactDeep({ a: `x ${v1}`, [`k-${v1}`]: [1, null, `y ${v1}`], n: 3 }, redact) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(v1);
    expect(out.n).toBe(3);
  });
});
