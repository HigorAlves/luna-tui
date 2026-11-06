import { describe, expect, it } from "vitest";

import { findingKinds } from "./findings.ts";

// Every value is built at runtime from parts: a token-shaped literal in a test blocks the push.
const j = (...parts: string[]) => parts.join("");
const cases: [string, string, string][] = [
  ["a connection string with a password", j("postgres", "://app:", "hunter2hunter2", "@db.internal:5432/app"), "credential"],
  ["a password assignment", j("DB_", "PASSWORD", "=", "correct-horse"), "credential"],
  ["a secret assignment in quotes", j('"client_', 'secret": "', "abc123def456", '"'), "credential"],
  ["a bearer header", j("Authorization", ": ", "Bearer ", "abcdefghij0123456789"), "credential"],
  ["a basic header", j("authorization", ": ", "Basic ", "dXNlcjpwYXNzd29yZA=="), "credential"],
  ["a private key block", j("-----BEGIN ", "OPENSSH PRIVATE KEY", "-----"), "private_key"],
  ["a payment key", j("sk", "_live_", "A".repeat(24)), "token"],
  ["a google key", j("AIza", "B".repeat(35)), "token"],
  ["a session cloud key", j("AS", "IA", "C".repeat(16)), "token"],
];

describe("findingKinds", () => {
  for (const [name, text, kind] of cases) it(`finds ${name}`, () => expect(findingKinds(`line one\n${text}\nline three`)).toContain(kind));

  it("finds nothing in plain output", () => {
    expect(findingKinds("3 passed, 0 failed in 1.2s\nGET /api/health 200\nuser@example.com")).toEqual([]);
  });

  it("finds a key after the 4,000th character: it reads the whole text", () => {
    expect(findingKinds("x ".repeat(4500) + j("gh", "p_", "a".repeat(36)))).toEqual(["token"]);
  });

  it("never returns the matched text", () => {
    const secret = j("DB_", "PASSWORD", "=", "correct-horse");
    expect(JSON.stringify(findingKinds(secret))).not.toContain("correct-horse");
  });
});
