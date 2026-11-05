import { describe, expect, it } from "vitest";

import { TOKEN_SHAPE, scrubContext } from "./scrub.ts";

// Token-shaped strings are built at run time: a literal would trip the host's push protection.
const slackToken = ["xox", "b-123456789012-abcdefghijklmnop"].join("");
const githubToken = ["gh", "p_", "a".repeat(36)].join("");

describe("scrubContext", () => {
  it("replaces each login, wherever it appears, with a stable user-N.example", () => {
    const out = scrubContext({ ship: { comment: { thread: { comments: [{ author: "rafaelsouza", body: "ping rafaelsouza and @higorx" }, { author: "higorx", body: "ok" }] } } } });
    expect(out).toEqual({ ok: true, value: { ship: { comment: { thread: { comments: [{ author: "user-1.example", body: "ping user-1.example and @user-2.example" }, { author: "user-2.example", body: "ok" }] } } } } });
  });

  it("rewrites emails to an .example address, and keeps the local part out", () => {
    const out = scrubContext({ issue: { description: "mail ana.silva@acme-corp.com about it" } });
    expect(out).toEqual({ ok: true, value: { issue: { description: "mail user-1@mail.example about it" } } });
  });

  it("keeps public URLs, moves internal hosts to .example, and drops the owner of a github.com repo", () => {
    const text = "see https://developer.mozilla.org/docs, https://git.acme.internal/team/api/pull/3, http://localhost:3000/x, https://github.com/acme-inc/secret-api/pull/9 and http://10.1.2.3:8080/a";
    const out = scrubContext({ issue: { description: text } }) as { ok: true; value: { issue: { description: string } } };
    expect(out.value.issue.description).toBe("see https://developer.mozilla.org/docs, https://host-1.example/team/api/pull/3, http://host-2.example/x, https://github.com/example/repo-1/pull/9 and http://host-3.example/a");
  });

  it("moves absolute home and work paths under /work", () => {
    const out = scrubContext({ check: { output: "at /Users/higor/Developer/projects/acme/src/a.ts:4 and /home/ci/build/pkg/b.ts" } }) as { ok: true; value: { check: { output: string } } };
    expect(out.value.check.output).toBe("at /work/src/a.ts:4 and /work/pkg/b.ts");
  });

  it("refuses a context holding a token-shaped string, naming nothing of the token", () => {
    for (const token of [slackToken, githubToken]) {
      expect(TOKEN_SHAPE.test(token)).toBe(true);
      const out = scrubContext({ ship: { comment: { thread: { comments: [{ author: "a", body: `my key is ${token}` }] } } } });
      expect(out).toEqual({ ok: false, reason: "a token-shaped string at ship.comment.thread.comments.0.body" });
    }
  });

  it("leaves a clean context as it was", () => {
    const clean = { plan: { brief: "Add an export button", slices: [{ title: "Export", acceptance: ["returns csv"] }], n: 3, flag: true, none: null } };
    expect(scrubContext(clean)).toEqual({ ok: true, value: clean });
  });

  it("refuses the wider token shapes, each built at run time", () => {
    const tokens = [
      ["glp", "at-", "a".repeat(20)],
      ["sk_", "live_", "A1b2C3d4E5f6"],
      ["rk_", "test_", "A1b2C3d4E5f6"],
      ["AI", "za", "A".repeat(35)],
      ["npm", "_", "a".repeat(36)],
      ["AS", "IA", "A".repeat(16)],
      ["hooks.slack.com", "/services/", "T0/B0/x"],
      ["xa", "pp-", "1-A0123456789"],
    ].map((parts) => parts.join(""));
    for (const token of tokens) {
      expect(TOKEN_SHAPE.test(token), token.slice(0, 6)).toBe(true);
      expect(scrubContext({ issue: { description: `see ${token}` } }).ok).toBe(false);
    }
  });

  it("drops the home directory's owner and everything up to the project", () => {
    const out = scrubContext({ check: { output: "at /Users/higor/Developer/projects/acme/src/a.ts and /home/ci/work/pkg/b.ts" } }) as { ok: true; value: { check: { output: string } } };
    expect(out.value.check.output).not.toMatch(/higor|\/ci\//);
    expect(out.value.check.output).toBe("at /work/src/a.ts and /work/pkg/b.ts");
  });

  it("rewrites owner and repo on every forge host, mentions, and dotted internal hostnames with or without a scheme", () => {
    const text = "https://gitlab.com/acme-inc/api/-/merge_requests/3 https://gist.github.com/someone/abc https://api.github.com/repos/acme-inc/api/pulls ping @rafaelsouza on build01.corp.internal and db.acme.local:5432";
    const out = scrubContext({ issue: { description: text } }) as { ok: true; value: { issue: { description: string } } };
    const d = out.value.issue.description;
    expect(d).toContain("https://gitlab.com/example/repo-1/-/merge_requests/3");
    expect(d).toContain("https://gist.github.com/example/repo-2");
    expect(d).toContain("https://api.github.com/repos/example/repo-1/pulls");
    expect(d).toContain("@user-1.example");
    expect(d).not.toMatch(/acme|rafael|corp\.internal|\.local/);
    expect(d).toMatch(/host-\d\.example/);
  });
});
