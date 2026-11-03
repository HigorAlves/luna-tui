import { describe, expect, it } from "vitest";

import { evePacks } from "./build.ts";

describe("evePacks", () => {
  it("builds an eve agent only for a pack whose engines allow eve", () => {
    expect(evePacks().map((p) => p.id).sort()).toEqual(["chat_triage", "slack_triage", "triage"]);
    expect(evePacks(["triage", "implementing"]).map((p) => p.id)).toEqual(["triage"]);
  });
});
