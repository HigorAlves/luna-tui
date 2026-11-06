import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTAINER_STAGE_KINDS, finalKind, isReservedKind } from "./reserved-kinds.ts";

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

describe("the kinds only the machine writes", () => {
  it("takes a container's kind to the kind it would be stored under: prefixed `stage.` unless it already is", () => {
    expect(finalKind("finished")).toBe("stage.finished");
    expect(finalKind("stage.finished")).toBe("stage.finished");
    expect(finalKind("slice.red")).toBe("stage.slice.red");
  });

  it("reserves every kind that would become a row the machine itself logs, and lets the agent's ledger kinds and its notes through", () => {
    for (const kind of ["finished", "stage.finished", "started", "stage.started", "engine", "held", "reattached", "restarted", "malformed", "pr.opened", "build.checkpoint", "ship.ready", "evidence.published", "verify.findings", "ci.status", "sandbox.egress_blocked", "stage.sandbox.egress_blocked"]) expect(isReservedKind(kind), kind).toBe(true);
    for (const kind of ["slice.red", "slice.green", "slice.committed", "stage.slice.red", "ledger.init", "step", "note", "something.new"]) expect(isReservedKind(kind), kind).toBe(false);
  });

  it("covers every `stage.*` kind the machine's own code logs: a new one that is not on the list fails here", () => {
    const logged = new Set<string>();
    for (const file of sources(join(import.meta.dirname, ".."))) {
      for (const match of readFileSync(file, "utf8").matchAll(/"(stage\.[a-z_.]+[a-z_])"/g)) logged.add(match[1]!);
    }
    // `stage.json` is a file name; the others are the agent's own ledger rows, which a container may write.
    const missing = [...logged].filter((kind) => kind !== "stage.json" && !CONTAINER_STAGE_KINDS.includes(kind) && !isReservedKind(kind));
    expect(missing).toEqual([]);
  });
});
