import type { SlackWatch } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { RULES_TEMPLATE, type RuleInput, applyRules, firstLine, inQuietHours, learn, parseRules, withFloor } from "./slack-rules.ts";

const now = new Date("2026-10-28T12:00:00Z");

const FILE = `# Slack triage rules

## VIPs
- @CTO
- U0VIP

## Muted channels
<!-- - #ignored-comment -->
- #random
- CMUTED

## Always P0 keywords
- Incident
- rollback

## Quiet hours
22:00-08:00

## Notes
Replies to the data team are in PT-BR.
Keep it short.

## Learned
<!-- maintained -->
- @bot-ci: lowered (3)
- #payments: raised (1)
`;

describe("parseRules", () => {
  it("reads every section, ignoring comments", () => {
    expect(parseRules(FILE)).toEqual({
      vips: ["cto", "u0vip"],
      muted: ["random", "cmuted"],
      p0Keywords: ["incident", "rollback"],
      quietHours: { start: 22 * 60, end: 8 * 60 },
      notes: "Replies to the data team are in PT-BR.\nKeep it short.",
      learned: { "@bot-ci": { direction: "lowered", n: 3 }, "#payments": { direction: "raised", n: 1 } },
    });
  });

  it("parses the shipped template to defaults", () => {
    const rules = parseRules(RULES_TEMPLATE);
    expect(rules.vips).toEqual([]);
    expect(rules.muted).toEqual([]);
    expect(rules.p0Keywords).toEqual(["incident", "outage"]);
    expect(rules.quietHours).toBeNull();
    expect(rules.notes).toBe("");
    expect(rules.learned).toEqual({});
  });

  it("knows the quiet window, across midnight", () => {
    const rules = parseRules(FILE);
    const at = (h: number) => {
      const d = new Date(now);
      d.setHours(h, 30, 0, 0);
      return d;
    };
    expect(inQuietHours(rules, at(23))).toBe(true);
    expect(inQuietHours(rules, at(3))).toBe(true);
    expect(inQuietHours(rules, at(12))).toBe(false);
    expect(inQuietHours(parseRules("## Quiet hours\n09:00-10:00"), at(9))).toBe(true);
  });
});

const watch = (over: Partial<SlackWatch>): SlackWatch => ({
  id: "w",
  kind: "channel",
  value: "C9",
  label: "#oncall",
  channels: [],
  enabled: true,
  builtin: false,
  priority: null,
  createdAt: now.toISOString(),
  ...over,
});

const input = (over: Partial<RuleInput> = {}): RuleInput => ({
  author: { id: "U2", name: "marta", isBot: false },
  text: "can you look?",
  channel: { id: "C1", name: "eng" },
  mentionsMe: true,
  isOwn: false,
  matched: ["me"],
  watches: [],
  ...over,
});

describe("applyRules", () => {
  const rules = parseRules(FILE);

  it("drops your own messages and muted channels", () => {
    expect(applyRules(input({ isOwn: true }), rules, now)).toEqual({ drop: true, reason: "own" });
    expect(applyRules(input({ channel: { id: "C5", name: "random" } }), rules, now)).toEqual({ drop: true, reason: "muted" });
    expect(applyRules(input({ channel: { id: "CMUTED", name: "x" } }), rules, now)).toEqual({ drop: true, reason: "muted" });
  });

  it("settles bot authors as automated P3 unless they mention you", () => {
    const bot = { id: "B1", name: "ci", isBot: true };
    const settled = applyRules(input({ author: bot, mentionsMe: false, text: "build 42 passed\nmore" }), rules, now);
    expect(settled).toMatchObject({ drop: false, floor: null, triage: { by: "rules", category: "automated", priority: "P3", expectsReply: false, summary: "build 42 passed" } });
    expect(applyRules(input({ author: bot, mentionsMe: true }), rules, now)).toEqual({ drop: false, triage: null, floor: null });
  });

  it("floors: VIPs to P1, P0 keywords to P0, a watch's priority", () => {
    expect(applyRules(input({ author: { id: "U0VIP", name: "x", isBot: false } }), rules, now)).toEqual({ drop: false, triage: null, floor: "P1" });
    expect(applyRules(input({ author: { id: "U7", name: "cto", isBot: false } }), rules, now)).toEqual({ drop: false, triage: null, floor: "P1" });
    expect(applyRules(input({ text: "we need a ROLLBACK" }), rules, now)).toEqual({ drop: false, triage: null, floor: "P0" });
    const watches = [watch({ priority: "P2" })];
    expect(applyRules(input({ matched: ["channel:C9"], watches }), rules, now)).toEqual({ drop: false, triage: null, floor: "P2" });
    expect(applyRules(input({ matched: ["channel:C9"], watches, author: { id: "U0VIP", name: "x", isBot: false } }), rules, now)).toMatchObject({ floor: "P1" });
  });

  it("a bot in a P0 keyword message still gets the floor", () => {
    const verdict = applyRules(input({ author: { id: "B1", name: "pager", isBot: true }, mentionsMe: false, text: "INCIDENT declared" }), rules, now);
    expect(verdict).toMatchObject({ triage: { priority: "P0", category: "automated" } });
  });

  it("withFloor raises the model's priority but never a hand override", () => {
    const triage = applyRules(input({ author: { id: "B1", name: "ci", isBot: true }, mentionsMe: false }), rules, now);
    if (triage.drop || !triage.triage) throw new Error("expected a settled triage");
    expect(withFloor(triage.triage, "P1").priority).toBe("P1");
    expect(withFloor(triage.triage, null).priority).toBe("P3");
    expect(withFloor({ ...triage.triage, overridden: true }, "P1").priority).toBe("P3");
    expect(withFloor({ ...triage.triage, priority: "P0" }, "P2").priority).toBe("P0");
  });

  it("cuts a first line to the row", () => {
    expect(firstLine("\n\n  hello \nworld")).toBe("hello");
    expect(firstLine("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});

describe("learn", () => {
  it("adds a line under Learned after its comment, then bumps or flips it", () => {
    const once = learn(RULES_TEMPLATE, "@marta", "lowered");
    expect(once.endsWith("- @marta: lowered (1)\n")).toBe(true);
    expect(parseRules(once).learned).toEqual({ "@marta": { direction: "lowered", n: 1 } });
    const twice = learn(once, "@marta", "lowered");
    expect(parseRules(twice).learned["@marta"]).toEqual({ direction: "lowered", n: 2 });
    expect(twice.match(/@marta/g)).toHaveLength(1);
    const flipped = learn(twice, "@marta", "raised");
    expect(parseRules(flipped).learned["@marta"]).toEqual({ direction: "raised", n: 1 });
    const other = learn(flipped, "#payments-oncall", "raised");
    expect(parseRules(other).learned).toEqual({ "@marta": { direction: "raised", n: 1 }, "#payments-oncall": { direction: "raised", n: 1 } });
  });

  it("appends the section when the file lacks it and keeps the rest", () => {
    const learned = learn("# rules\n\n## VIPs\n- @a\n", "@b", "raised");
    expect(learned).toBe("# rules\n\n## VIPs\n- @a\n\n## Learned\n\n- @b: raised (1)\n");
    expect(parseRules(learned).vips).toEqual(["a"]);
  });
});

describe("the shipped rules file", () => {
  it("is the template (learned lines aside)", async () => {
    const { readFile } = await import("node:fs/promises");
    const shipped = await readFile(new URL("../../../docs/agents/slack-triage.md", import.meta.url), "utf8");
    const withoutLearned = (text: string) => text.replace(/^- .+: (lowered|raised) \(\d+\)\n/gm, "");
    expect(withoutLearned(shipped)).toBe(withoutLearned(RULES_TEMPLATE));
  });
});
