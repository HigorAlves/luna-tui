import { describe, expect, it } from "vitest";

import { evePacks } from "./build.ts";
import { appName } from "./compile.ts";

describe("evePacks", () => {
  it("builds an eve agent only for a pack whose engines allow eve, and for each helper on an eve engine", () => {
    expect(evePacks().map(appName).sort()).toEqual(["chat_triage", "decide", "decompose", "memory_answer", "memory_extract", "plan", "slack_triage", "triage", "verifying", "verifying--second-opinion", "video_qa"]);
    expect(evePacks(["triage", "implementing"]).map((p) => p.id)).toEqual(["triage"]);
    expect(evePacks(["verifying--second-opinion"])).toEqual([expect.objectContaining({ id: "verifying", agent: "second-opinion", writable: false })]);
  });
});
