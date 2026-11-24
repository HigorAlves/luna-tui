import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { maskKey, maskedPack } from "./mask.ts";

describe("maskedPack", () => {
  it("is the same pack with no mask, or a mask that removes nothing", () => {
    expect(maskedPack(PACKS.triage, undefined)).toBe(PACKS.triage);
    expect(maskedPack(PACKS.triage, {})).toBe(PACKS.triage);
  });

  it("removes the masked units from the access and the skills, and a masked agent takes the Claude subagents with it", () => {
    const pack = maskedPack(PACKS.triage, { web: true, agent: true, skills: ["code-discovery"], luna: ["card_search", "decision_get"] });
    if (pack.kind !== "agent") throw new Error("agent pack");
    expect(pack.access).toMatchObject({ web: false, agent: false, skills: false });
    expect(pack.access.luna).toEqual(["step", "decision_get"]);
    expect(pack.skills).toEqual([]);
    expect(pack.helpers).toEqual([]);
  });

  it("leaves a decision pack alone", () => {
    expect(maskedPack(PACKS.red_check, { web: true })).toBe(PACKS.red_check);
  });
});

describe("maskKey", () => {
  it("is null for no mask and for one with nothing a mask may remove, and the same for one mask in any order", () => {
    expect(maskKey(undefined)).toBeNull();
    expect(maskKey({ luna: ["step"], skills: [] })).toBeNull();
    expect(maskKey({ skills: ["b", "a"], web: true })).toBe(maskKey({ web: true, skills: ["a", "b", "a"] }));
    expect(maskKey({ web: true })).not.toBe(maskKey({ agent: true }));
  });
});
