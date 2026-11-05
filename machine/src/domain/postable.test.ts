import { describe, expect, it } from "vitest";

import { archivedNotice, questionsComment } from "./notices.ts";
import { carriesSecret, flattenLinks, postable } from "./postable.ts";

describe("postable", () => {
  it("shows a link's address in the open and drops an image", () => {
    expect(postable("See [the docs](https://evil.example/login) now")).toBe("See the docs (https://evil.example/login) now");
    expect(postable("before ![tracking pixel](https://evil.example/p.png) after")).toBe("before  after".replace("  ", " "));
    expect(flattenLinks("![a](http://x) [b](http://y)")).toBe(" b (http://y)");
  });

  it("still flattens lines, mentions, issue references and HTML, and redacts a token", () => {
    expect(postable("a\nb @bob #12 <b>x</b>")).toBe("a b @\u200bbob #\u200b12 &lt;b&gt;x&lt;/b&gt;");
    expect(postable(`key ${["ghp", "a".repeat(36)].join("_")}`)).toBe("key [redacted]");
  });

  it("does not backtrack on a long run of brackets", () => {
    const started = Date.now();
    postable("[".repeat(50_000) + "](" + "(".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("questionsComment", () => {
  it("is one flattened comment with a hash of the raw texts, and secret is read from the raw text", () => {
    const clean = questionsComment([{ question: "Which one?", recommended: "a" }]);
    expect(clean).toMatchObject({ body: "Luna needs your answers to go on: 1) Which one? (suggested: a)", secret: false });
    expect(clean.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(questionsComment([{ question: "Which one?", recommended: "a" }]).hash).toBe(clean.hash);
    expect(questionsComment([{ question: "Which one?", recommended: "b" }]).hash).not.toBe(clean.hash);
    const leaky = questionsComment([{ question: `Is ${["ghp", "a".repeat(36)].join("_")} yours?`, recommended: null }]);
    expect(leaky.secret).toBe(true);
    expect(carriesSecret(leaky.body)).toBe(false);
    expect(questionsComment([{ question: "q", recommended: ["xoxb", "1".repeat(12)].join("-") }]).secret).toBe(true);
  });

  it("tells an archived card why in fixed words", () => {
    expect(archivedNotice("no_answer")).toBe("Archived: nobody answered the questions in time.");
    expect(archivedNotice("duplicate")).toBe("Archived: duplicate.");
  });
});
