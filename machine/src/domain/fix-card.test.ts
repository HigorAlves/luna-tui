import { describe, expect, it } from "vitest";

import { parseNote } from "./fix-card.ts";

describe("parseNote", () => {
  it("reads t=, scene= and el= anywhere in the text and removes them from it", () => {
    expect(parseNote("t=12.5 scene=cart el=cta the headline is cut off")).toEqual({ t: 12.5, scene: "cart", element: "cta", text: "the headline is cut off" });
    expect(parseNote("the headline scene=cart is cut off t=3 el=h1")).toEqual({ t: 3, scene: "cart", element: "h1", text: "the headline is cut off" });
  });

  it("reads @m:ss and @seconds as the time", () => {
    expect(parseNote("@1:05 the voice is late")).toEqual({ t: 65, scene: null, element: null, text: "the voice is late" });
    expect(parseNote("the voice is late @42.5")).toEqual({ t: 42.5, scene: null, element: null, text: "the voice is late" });
  });

  it("makes a note with no tokens a whole-film card", () => {
    expect(parseNote("  too fast overall ")).toEqual({ t: null, scene: null, element: null, text: "too fast overall" });
  });

  it("is null for an empty, blank or absent reason", () => {
    expect(parseNote(null)).toBeNull();
    expect(parseNote("")).toBeNull();
    expect(parseNote("   \n ")).toBeNull();
  });

  it("keeps a card whose text is only tokens, and ignores words that merely look like them", () => {
    expect(parseNote("t=7")).toEqual({ t: 7, scene: null, element: null, text: "" });
    expect(parseNote("meet@5pm; fast=yes")).toEqual({ t: null, scene: null, element: null, text: "meet@5pm; fast=yes" });
  });
});
