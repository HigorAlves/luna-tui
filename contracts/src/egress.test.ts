import { describe, expect, it } from "vitest";

import { hostPatternProblem, normalizeHostPattern, secretNameProblem, urlPatternProblem } from "./egress.ts";

describe("hostPatternProblem", () => {
  it("accepts a host, a host with a port and a leading wildcard, in any case", () => {
    for (const ok of ["registry.npmjs.org", "Docs.Example.com", "example.com:8443", "*.example.com", "*.cdn.example.co.uk:443", "xn--bcher-kva.example"]) {
      expect(hostPatternProblem(ok), ok).toBeNull();
    }
    expect(normalizeHostPattern(" Docs.Example.COM:443 ")).toBe("docs.example.com:443");
  });

  it("refuses an IPv4 or IPv6 literal in any spelling, naming the entry", () => {
    for (const bad of ["1.2.3.4", "1.2.3.4:443", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0x7f.0.0.1", "[::1]", "::1", "[::ffff:127.0.0.1]:443", "fe80::1", "10.0.0.1.", "999.1.1.1"]) {
      const problem = hostPatternProblem(bad);
      expect(problem, bad).not.toBeNull();
      expect(problem, bad).toContain(JSON.stringify(bad));
    }
  });

  it("refuses a lone star, a wildcard that is not the first label, a name with no dot and the local names", () => {
    for (const bad of ["*", "*.com", "a.*.example.com", "ex*.example.com", "**.example.com", "com", "localhost", "localhost:3000", "db.internal", "printer.local", "x.localhost", "metadata.google.internal"]) {
      expect(hostPatternProblem(bad), bad).not.toBeNull();
    }
  });

  it("refuses a scheme, a path, userinfo, spaces, a bad port, an empty label and anything over 253 characters", () => {
    for (const bad of ["https://example.com", "example.com/x", "user@example.com", "exa mple.com", "example.com:0", "example.com:65536", "example.com:abc", "a..example.com", "-a.example.com", "a-.example.com", "exämple.com", "example.com\n", "", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`, `${"a".repeat(64)}.example.com`]) {
      expect(hostPatternProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("secretNameProblem", () => {
  it("accepts an ordinary name", () => {
    for (const ok of ["QA_PASSWORD", "STRIPE_TEST_KEY", "DB_URL"]) expect(secretNameProblem(ok), ok).toBeNull();
  });

  it("refuses the engines' and the machine's own names, the proxy variables and the reserved prefixes", () => {
    for (const bad of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "LMNR_PROJECT_API_KEY", "PATH", "HOME", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "YARN_HTTP_PROXY", "YARN_HTTPS_PROXY", "HARDNESS_X", "LUNA_X", "MACHINE_X", "GIT_DIR", "NODE_OPTIONS", "LD_PRELOAD", "CLAUDE_X", "CODEX_X"]) {
      expect(secretNameProblem(bad), bad).toContain(bad);
    }
  });

  it("refuses a name that is not upper snake case", () => {
    for (const bad of ["qa_password", "1ABC", "A", "A-B", "A".repeat(65), ""]) expect(secretNameProblem(bad), bad).not.toBeNull();
  });
});

describe("urlPatternProblem", () => {
  it("accepts an https URL whose only placeholders are the four the machine fills", () => {
    for (const ok of ["https://{branch}.preview.example.com", "https://pr-{card}.example.com/app", "https://{short_sha}-{sha}.example.com/"]) expect(urlPatternProblem(ok), ok).toBeNull();
  });

  it("refuses http, userinfo, a query, a fragment, an unknown placeholder, a placeholder in the registrable part and a bad host", () => {
    for (const bad of ["http://x.example.com", "https://u:p@x.example.com", "https://x.example.com/?a=1", "https://x.example.com/#f", "https://{user}.example.com", "https://x.{branch}.com", "https://example.{branch}", "https://127.0.0.1/x", "https://localhost/x", "https://example", "{branch}.example.com", "https://x.example.com/{"]) {
      expect(urlPatternProblem(bad), bad).not.toBeNull();
    }
  });
});
