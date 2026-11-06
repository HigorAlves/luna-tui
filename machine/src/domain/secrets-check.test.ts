import { describe, expect, it } from "vitest";

import { carriesSecret } from "./postable.ts";
import { maskPii, screen } from "./secrets-check.ts";

const j = (...parts: string[]): string => parts.join("");

describe("screen", () => {
  it("cuts every shape redact() knows", () => {
    const text = `key ${j("sk", "-ant-", "a1b2c3d4e5f6")} and ${j("gh", "p_", "A".repeat(24))}`;
    const out = screen(text);
    expect(out.text).toBe("key [redacted] and [redacted]");
    expect(out.secrets).toBe(2);
    expect(carriesSecret(out.text)).toBe(false);
  });

  it("cuts private key blocks, Slack app tokens, webhooks and vendor keys", () => {
    const block = j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA ", "PRIVATE KEY-----");
    const shapes = [
      block,
      j("xa", "pp-1-A0123456789-", "1234567890-abcdef"),
      j("https://hooks.", "slack.com/services/", "T0123ABCD/B0123ABCD/", "abcdefghijklmnop"),
      j("sk_", "live_", "A".repeat(24)),
      j("AI", "za", "A".repeat(35)),
      j("npm", "_", "a".repeat(36)),
    ];
    for (const shape of shapes) {
      const out = screen(`before ${shape} after`);
      expect(out.text, shape.slice(0, 12)).toBe("before [redacted] after");
      expect(out.secrets).toBe(1);
    }
  });

  it("cuts a card number that passes Luhn and keeps one that does not", () => {
    expect(screen("pay 4242 4242 4242 4242 now").text).toBe("pay [redacted] now");
    expect(screen("order 4242 4242 4242 4241 now").text).toBe("order 4242 4242 4242 4241 now");
    expect(screen("ts 1700000000123455").secrets).toBe(0);
  });

  it("cuts a social security number", () => {
    expect(screen("ssn 123-45-6789.").text).toBe("ssn [redacted].");
    expect(screen("ssn 000-12-3456").text).toBe("ssn 000-12-3456");
  });

  it("keeps e-mail addresses and phone numbers and names them in pii", () => {
    const out = screen("mail ana@example.com or call +1 415-555-0132");
    expect(out.text).toBe("mail ana@example.com or call +1 415-555-0132");
    expect(out.pii.sort()).toEqual(["email", "phone"]);
    expect(out.secrets).toBe(0);
  });
});

describe("maskPii", () => {
  it("replaces e-mail addresses and phone numbers", () => {
    expect(maskPii("mail ana@example.com or call +1 415-555-0132 or (415) 555 0132")).toBe("mail [email] or call [phone] or [phone]");
  });
  it("leaves plain text alone", () => {
    expect(maskPii("deploy 1700000000.123 failed in 3 regions")).toBe("deploy 1700000000.123 failed in 3 regions");
  });
});
