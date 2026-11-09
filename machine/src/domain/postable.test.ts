import { describe, expect, it } from "vitest";

import { archivedNotice, questionsComment } from "./notices.ts";
import { carriesSecret, flattenLinks, postable, postableDraft, postableKeeping } from "./postable.ts";

describe("postable", () => {
  it("shows a link's address in the open and drops an image", () => {
    expect(postable("See [the docs](https://evil.example/login) now")).toBe("See the docs (https\u200b://evil.example/login) now");
    expect(postable("before ![tracking pixel](https://evil.example/p.png) after")).toBe("before  after".replace("  ", " "));
    expect(flattenLinks("![a](http://x) [b](http://y)")).toBe(" b (http://y)");
  });

  it("still flattens lines, mentions, issue references and HTML, and redacts a token", () => {
    expect(postable("a\nb @bob #12 <b>x</b>")).toBe("a b @\u200bbob #\u200b12 &lt;b&gt;x&lt;/b&gt;");
    expect(postable(`key ${["ghp", "a".repeat(36)].join("_")}`)).toBe("key [redacted]");
  });

  it("leaves nothing GitHub would turn into a link in a bare address, a www. address or a labelled link", () => {
    const out = postable("see https://evil.example/a and www.evil.example/b and [the docs](https://evil.example/c) and ![px](http://evil.example/p.png) and <https://evil.example/d> and GH-7");
    expect(out).not.toMatch(/https?:\/\/|\bwww\.|\]\(|GH-\d/i);
    expect(out).toContain("evil.example/a");
  });

  it("leaves no live link or image, however the label is written", () => {
    // A label over two lines: the lines are joined after the links were read, so the link must be broken afterwards too.
    expect(postable("[click\nhere](https://evil.example/a)")).not.toContain("](");
    expect(postable("![pixel\nalt](https://evil.example/p.png?d=1)")).not.toContain("](");
    // Brackets inside the label, an escaped bracket, a label past the rewrite's bound.
    expect(postable("[a [b] c](https://evil.example/b)")).not.toContain("](");
    expect(postable("[a\\]b](https://evil.example/c)")).not.toContain("](");
    expect(postable(`[${"x".repeat(400)}](https://evil.example/d)`)).not.toContain("](");
    // A reference definition, which would arm a later `[a]`.
    expect(postable("[a]: https://evil.example/e")).not.toMatch(/\]:/);
    // The address stays readable.
    expect(postable("[click\nhere](https://evil.example/a)")).toContain("https\u200b://evil.example/a");
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

describe("postableKeeping", () => {
  const pr = "https://github.com/acme/app/pull/4";
  it("prints an address the machine supplied whole and still breaks every other one", () => {
    expect(postableKeeping(`The fix is in ${pr}. Also https://evil.example/x`, [pr])).toBe(`The fix is in ${pr}. Also https\u200b://evil.example/x`);
  });
  it("ignores a supplied value that is not a plain web address", () => {
    expect(postableKeeping("see javascript:alert(1)", ["javascript:alert(1)"])).toBe("see javascript:alert(1)");
    expect(postableKeeping(`go to ${pr}`, [])).toBe(`go to https\u200b://github.com/acme/app/pull/4`);
  });
});

describe("a company memory item's marker never leaves the machine", () => {
  it("is dropped from every postable text", () => {
    const out = postable("Per the handbook [luna:co_a1B2-c3] and LUNA: co_zz9 you may ship; see luna:mem_0001");
    expect(out).not.toMatch(/co_/i);
    expect(out).toContain("luna:mem_0001");
    expect(postableKeeping("limit is 5 luna:co_x1", [])).toBe("limit is 5");
  });
  it("makes a draft that carries one refused", () => {
    expect(postableDraft("the policy says so (luna:co_abc)", [])).toBeNull();
    expect(postableDraft("the policy says so (luna:mem_abc)", [])).not.toBeNull();
  });
});
