import { describe, expect, it, vi } from "vitest";

import { judgePrivacy, privacyTexts } from "./frame-privacy.ts";

const answer = (choice: string, confidence: number) => ({ exposure: { choice, confidence } });

describe("privacyTexts", () => {
  it("flattens, drops the empty and the repeated, caps each at 1000 characters and the list at 40", () => {
    const texts = privacyTexts([{ text: "a\n\nb  c" }, { text: "a b c" }, { text: "   " }, { text: "x".repeat(1500) }, ...Array.from({ length: 60 }, (_, i) => ({ text: `t${i}` }))]);
    expect(texts[0]).toBe("a b c");
    expect(texts[1]).toHaveLength(1000);
    expect(texts).toHaveLength(40);
    expect(new Set(texts).size).toBe(40);
  });
});

describe("judgePrivacy", () => {
  const ask = (reply: unknown) => vi.fn(async () => reply as Record<string, unknown>);
  it("is clear only for none at proceed", async () => {
    expect(await judgePrivacy(ask(answer("none", 0.9)), {}, ["x"], null)).toBe("clear");
    expect(await judgePrivacy(ask(answer("none", 0.6)), {}, ["x"], null)).toBe("exposed");
    expect(await judgePrivacy(ask(answer("credential", 0.9)), {}, ["x"], null)).toBe("exposed");
    expect(await judgePrivacy(ask(answer("personal_data", 0.55)), {}, ["x"], null)).toBe("exposed");
  });
  it("is not judged with no decision or an error, and asks nothing for no text", async () => {
    expect(await judgePrivacy(null, {}, ["x"], null)).toBe("not_judged");
    expect(await judgePrivacy(vi.fn(async () => { throw new Error("down"); }), {}, ["x"], null)).toBe("not_judged");
    const never = ask(answer("none", 0.9));
    expect(await judgePrivacy(never, {}, [], null)).toBe("clear");
    expect(never).not.toHaveBeenCalled();
  });
  it("asks frame_privacy with a frames check context", async () => {
    const decide = ask(answer("none", 0.9));
    await judgePrivacy(decide, {}, ["Cart"], "/repo");
    expect(decide).toHaveBeenCalledWith("frame_privacy", { kind: "frames", frames: { texts: ["Cart"] } }, "/repo");
  });
});
