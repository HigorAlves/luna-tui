import { describe, expect, it } from "vitest";

import { carriesCompanyMarker, companyMemoryId, isCompanyMemoryId, memoryMarker } from "./memory.ts";

describe("company memory markers", () => {
  it("recognises a company id and its marker", () => {
    const id = companyMemoryId("ab12-CD_3");
    expect(id).toBe("co_ab12-CD_3");
    expect(isCompanyMemoryId(id)).toBe(true);
    expect(isCompanyMemoryId("mem_0001")).toBe(false);
    expect(carriesCompanyMarker(`see ${memoryMarker(id)} for the policy`)).toBe(true);
    expect(carriesCompanyMarker("see luna:mem_0001")).toBe(false);
  });
  it("catches a marker typed in another case or with a space", () => {
    expect(carriesCompanyMarker("LUNA:CO_abc")).toBe(true);
    expect(carriesCompanyMarker("luna: co_abc")).toBe(true);
  });
  it("keeps only safe characters in a suffix", () => {
    expect(companyMemoryId("a b/../c")).toBe("co_abc");
  });
});
