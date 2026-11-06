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

describe("screen: the shapes this project's credentials take", () => {
  const join = (...parts: string[]) => parts.join("");
  const body = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  it("cuts OpenAI-style, gateway and decision-engine keys", () => {
    for (const key of [join("sk", "-", "proj", "-", body), join("sk", "-", body), join("vck", "_", body), join("tsk", "_", body)]) {
      const out = screen(`the key is ${key} ok`);
      expect(out.text, key).toBe("the key is [redacted] ok");
      expect(out.secrets).toBe(1);
    }
  });
  it("cuts the password of a credential in an address and keeps the rest of it", () => {
    const out = screen(join("postgres", "://", "app", ":", "hunter2hunter2", "@db.internal:5432/main"));
    expect(out.text).toBe(join("postgres", "://", "app", ":", "[redacted]", "@db.internal:5432/main"));
    expect(out.text).not.toContain("hunter2");
    expect(out.secrets).toBe(1);
  });
  it("cuts the value of a password, secret or token assignment", () => {
    for (const [line, kept] of [[join("pass", "word", "=", "correct-horse-battery"), "password="], [join("DB_PASS", "WORD", ": ", "s3cretValue"), "DB_PASSWORD: "], [join("tok", "en", ": ", "abc123def456"), "token: "], [join("client_", "secret", " = ", "\"zzTop99xx\""), "client_secret = "]] as const) {
      const out = screen(`set ${line} now`);
      expect(out.text, line).toContain("[redacted]");
      expect(out.text, line).toContain(kept);
      expect(out.text, line).not.toMatch(/horse|s3cretValue|abc123def|zzTop/);
    }
  });
  it("leaves plain prose and an assignment with no value alone", () => {
    const text = "the token expired; secret santa on friday, sk-learn is a library, and password=";
    expect(screen(text).text).toBe(text);
  });
});
