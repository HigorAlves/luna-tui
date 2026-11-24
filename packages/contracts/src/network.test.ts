import { describe, expect, it } from "vitest";

import { AGENT_PACKS, PACKS, helperPack } from "./index.ts";

describe("the network of an agent pack", () => {
  it("is declared by every agent pack, as one of engine, github or full", () => {
    const missing = AGENT_PACKS.filter((pack) => !["engine", "github", "full"].includes((pack as { network?: string }).network ?? "")).map((pack) => pack.id);
    expect(missing).toEqual([]);
  });

  it("is full for a pack that writes the worktree or reaches a QA target", () => {
    for (const pack of AGENT_PACKS) {
      if (pack.writable) expect(pack.network, pack.id).toBe("full");
    }
    expect(PACKS.e2e.network).toBe("full");
    expect(PACKS.recording.network).toBe("full");
  });

  it("is github for a pack that runs gh or reads an issue, engine for one that does neither", () => {
    expect(PACKS.triage.network).toBe("github");
    expect(PACKS.ci_watch.network).toBe("github");
    expect(PACKS.chat_triage.network).toBe("engine");
    expect(PACKS.slack_triage.network).toBe("engine");
    expect(PACKS.foreman.network).toBe("engine");
    expect(PACKS.fact_propose.network).toBe("engine");
  });

  it("is inherited by a helper from its parent", () => {
    for (const parent of [PACKS.triage, PACKS.verifying, PACKS.council_second]) {
      expect(helperPack(parent, { role: "second-opinion", engine: "codex:sol" }).network).toBe(parent.network);
    }
  });
});
