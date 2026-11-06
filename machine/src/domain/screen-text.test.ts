import { describe, expect, it } from "vitest";

import { screenFindings } from "./screen-text.ts";

const at = (text: string, t = 12.5) => [{ t, text }];
const kinds = (text: string) => screenFindings(at(text)).map((h) => h.kind);
const token = "gh" + "p_" + "a".repeat(36);

describe("screenFindings", () => {
  it("finds the token shapes redact knows, and says where and what kind, never the text", () => {
    const hits = screenFindings(at(`api key ${token}`));
    expect(hits).toEqual([{ place: "12.5 s", kind: "token" }]);
    expect(JSON.stringify(hits)).not.toContain(token);
  });

  it("finds a private key header", () => {
    expect(kinds("-----BEGIN " + "RSA PRIVATE KEY" + "-----")).toEqual(["private_key"]);
  });

  it("finds an e-mail address, but not one at a reserved or test domain", () => {
    expect(kinds("write to jane.roe@acme-corp.io")).toEqual(["email"]);
    for (const domain of ["example.com", "example.org", "example.net", "x.test", "x.invalid", "localhost"]) expect(kinds(`me@${domain}`), domain).toEqual([]);
    expect(kinds("me@example.com.evil.io")).toEqual(["email"]);
  });

  it("finds a phone number of ten digits or more, in any spacing", () => {
    expect(kinds("call +1 (415) 555-0132 now")).toEqual(["phone"]);
    expect(kinds("order 12345 of 678")).toEqual([]);
  });

  it("finds a card number that passes the Luhn check, and not one that does not", () => {
    expect(kinds("card 4111 1111 1111 1111")).toContain("card");
    expect(kinds("card 4111 1111 1111 1112")).not.toContain("card");
  });

  it("names a file as the place for a screenshot and the transcript as its own place", () => {
    expect(screenFindings([{ file: "cart.png", text: `x ${token}` }])).toEqual([{ place: "cart.png", kind: "token" }]);
    expect(screenFindings([{ file: "transcript", text: `x ${token}` }])[0]!.place).toBe("transcript");
  });

  it("finds nothing in clean text, and reports a kind once per place", () => {
    expect(screenFindings(at("Cart total $12.00, 3 items"))).toEqual([]);
    expect(screenFindings(at(`${token} ${token}`))).toHaveLength(1);
  });
});
