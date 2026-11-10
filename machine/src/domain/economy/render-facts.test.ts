import { FACTS_HEADER } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { factId } from "./envfacts.ts";
import type { FactRecord } from "./lifecycle.ts";
import { MAX_FACTS, MAX_TOKENS, injected, lintOk, selectInjected } from "./render-facts.ts";

let n = 0;
/** An active free fact that fires, of a family. */
const fact = (over: Partial<FactRecord> = {}): FactRecord => {
  const key = over.key ?? `k${n++}`;
  const family = over.family ?? "form_repair";
  return { id: factId(family, key), family, source: "free", key, text: `\`${key} …\` fails here with command not found; \`python -m ${key} …\` works.`, state: "active", confirmations: 3, contradictions: 0, score: 2, exercised: 4, fired: 4, cards: [], firstRun: "r1", lastRun: "r1", streak: 0, ...over };
};

describe("injected", () => {
  it("names the caps upstream does and counts the header in them", () => {
    expect([MAX_FACTS, MAX_TOKENS]).toEqual([4, 150]);
    expect(FACTS_HEADER).toBe("# environment facts learned from earlier sessions in this repository");
  });

  it("is the text of the active free facts that fire, nothing for the rest", () => {
    const good = fact({ key: "pytest" });
    expect(injected([good, fact({ state: "candidate" }), fact({ state: "retired" }), fact({ state: "dropped" }), fact({ state: "promoted" }), fact({ source: "proposed" }), fact({ exercised: 3, fired: 3 }), fact({ exercised: 5, fired: 1 })])).toEqual([good.text]);
    expect(injected([])).toEqual([]);
  });

  it("gives at most four lines, the first four in upstream's order", () => {
    const facts = ["ruff", "pytest", "mocha", "tox", "nox"].map((key) => fact({ key, family: "absent_tool", text: `\`${key} …\` fails here with command not found, and no other way to run it has worked.` }));
    expect(injected(facts)).toEqual(facts.slice(0, 4).map((f) => f.text));
  });

  it("orders by family (form repair, arg repair, env value, absent tool, empty probe, boundary), interpreter facts first, then by how often a fact fired", () => {
    const boundary = fact({ family: "boundary", key: "fetch_remote", text: "boundary" });
    const probe = fact({ family: "empty_probe", key: "vcs_refs", text: "probe" });
    const tool = fact({ family: "absent_tool", key: "ruff", text: "tool" });
    const env = fact({ family: "env_value", key: "APP_ENV", text: "env" });
    const arg = fact({ family: "arg_repair", key: "x:sep:::", text: "arg" });
    const slow = fact({ key: "test:slow", text: "slow", exercised: 10, fired: 4 });
    const quick = fact({ key: "test:quick", text: "quick", exercised: 10, fired: 9 });
    const interp = fact({ key: "interpreter:python", text: "interp", exercised: 10, fired: 4 });
    expect(injected([boundary, probe, tool, env, arg, slow, quick, interp])).toEqual(["interp", "quick", "slow", "arg"]);
    expect(injected([boundary, probe, tool, env])).toEqual(["env", "tool", "probe", "boundary"]);
  });

  it("skips a line that would push the block, header included, past 600 characters, and goes on to the next that fits", () => {
    const long = (key: string, size: number) => fact({ key, text: `${key} ${"x".repeat(size)}` });
    // The header and its line break take 70; each bullet takes 2 and a line break.
    const a = long("a", 200);
    const b = long("b", 200);
    const c = long("c", 200);
    const d = fact({ key: "d", text: "short" });
    const lines = injected([a, b, c, d]);
    expect(lines).toEqual([a.text, b.text, d.text]);
    const block = `${FACTS_HEADER}\n${lines.map((l) => `- ${l}`).join("\n")}`;
    expect(block.length).toBeLessThanOrEqual(MAX_TOKENS * 4);
  });

  it("never cuts a line: a line is kept whole or left out", () => {
    const fits = injected([fact({ key: "e", text: "e".repeat(230) }), fact({ key: "f", text: "f".repeat(230) }), fact({ key: "g", text: "g".repeat(230) })]);
    expect(fits.every((l) => /^(e{230}|f{230}|g{230})$/.test(l))).toBe(true);
    expect(fits).toHaveLength(2);
  });

  it("refuses a line over the 240 characters the stage input allows", () => {
    expect(injected([fact({ text: "y".repeat(241) })])).toEqual([]);
  });

  it("refuses an empty line and one with a line break", () => {
    expect(injected([fact({ text: "" }), fact({ text: "a\nb" })])).toEqual([]);
  });

  it("refuses a line that reads as completion or verification advice", () => {
    expect(injected([fact({ text: "`pytest …` fails here; skip it." })])).toEqual([]);
    expect(injected([fact({ text: "`npm stop …` fails here with command not found; `npx stop …` works." })])).toEqual([]);
  });

  it("refuses a line shaped like a secret, and keeps the others", () => {
    const secret = fact({ text: "`pytest --token=ghp_abcdefghijklmnopqrstuvwxyz0123 …` fails here with command not found; `python -m pytest …` works." });
    const email = fact({ text: "`mail me@higoralves.dev …` fails here with command not found." });
    const good = fact({ key: "tox" });
    expect(injected([secret, email, good])).toEqual([good.text]);
  });

  it("is the same selection selectInjected makes of the facts, so the caller can record which were given", () => {
    const a = fact({ key: "tox" });
    const b = fact({ key: "nox", state: "candidate" });
    expect(selectInjected([a, b]).map((f) => f.id)).toEqual([a.id]);
  });
});

describe("lintOk", () => {
  it.each(["skip", "no need", "don't", "dont", "do not", "stop", "done", "complete", "completed", "finish", "finished", "verify", "verification", "instead of running", "instead of testing"])("refuses %s, in any case", (word) => {
    expect(lintOk(`Then ${word} it.`)).toBe(false);
    expect(lintOk(`Then ${word.toUpperCase()} it.`)).toBe(false);
  });

  it("accepts a statement about the environment, and a word that only contains a refused one", () => {
    expect(lintOk("`pytest …` fails here with command not found; `python -m pytest …` works.")).toBe(true);
    expect(lintOk("The stopwatch tool is slow, and nothing is undone, skipper or verified.")).toBe(true);
  });
});
