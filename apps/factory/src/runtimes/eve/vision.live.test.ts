// Live, opt-in (LUNA_LIVE_VISION=1): does an engine on the Codex login read an image eve's read_file returns (RFC 0013, phase 4)?
// The real eve runtime and the real chatgpt() model on the host's Codex login; no machine, no container. Each passing engine's
// catalog entry gets vision: true (packages/contracts/src/models.ts).
import { type AgentPack, type EngineId, PACKS, helperPack, resolveEngine } from "@hardness/contracts";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lunaHandlers } from "../../core/luna-tools.ts";
import { stageInput } from "../conformance/table.ts";
import { compileAndBuild } from "./build.ts";
import { eveRuntime } from "./run.ts";

const FACTORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const live = process.env.LUNA_LIVE_VISION === "1";
const ENGINES: EngineId[] = ["codex:sol", "codex:luna"];
/** A read-only helper pack that reads and answers `{ answer }`; its app does not depend on the engine (the model is chosen at run time). */
const probePack = (engine: EngineId): AgentPack => helperPack(PACKS.reviewing as AgentPack, { role: "security-reviewer", engine });

describe.skipIf(!live)("vision on the Codex login (live)", () => {
  const agentsDir = live ? mkdtempSync(join(FACTORY_ROOT, ".eve-agents-vision-")) : "";
  beforeAll(() => {
    compileAndBuild(probePack("codex:sol"), { factoryRoot: FACTORY_ROOT, outDir: agentsDir });
  }, 300_000);
  afterAll(() => {
    if (agentsDir) rmSync(agentsDir, { recursive: true, force: true });
  });

  /** Asks the engine for the color of a square saved under a name that does not give it away. */
  const colorSeen = async (engine: EngineId, fixture: "red" | "green", vision: boolean): Promise<{ error: string | null; answer: string }> => {
    const root = mkdtempSync(join(tmpdir(), "vision-"));
    try {
      const design = join(root, "design");
      for (const d of ["work", "out", "scratch", "design"]) mkdirSync(join(root, d), { recursive: true });
      copyFileSync(join(FACTORY_ROOT, "test-fixtures", "vision", `${fixture}.png`), join(design, "square.png"));
      const pack = probePack(engine);
      // The probe sets vision itself, whatever the catalog says today: the catalog is what this measures.
      const run = await eveRuntime({ agentsDir, vision }).run({
        pack,
        engine: resolveEngine(engine),
        input: stageInput(pack, engine, 120_000),
        prompt: `Read ${join(design, "square.png")} with read_file. In \`answer\`, give only the color of the square, or "unknown" if you cannot see it.`,
        paths: { factoryRoot: FACTORY_ROOT, work: join(root, "work"), out: join(root, "out"), input: root, scratch: join(root, "scratch"), images: [design] },
        luna: lunaHandlers({ ledgerPath: join(root, "out", "ledger.json"), decisions: [], emit: () => {} }),
        dry: false,
        emit: () => {},
      });
      return { error: run.error, answer: String((run.structured as { answer?: string } | null)?.answer) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it.each(ENGINES)("%s names the color of each square it reads, and cannot when the image is withheld", async (engine) => {
    const red = await colorSeen(engine, "red", true);
    const green = await colorSeen(engine, "green", true);
    const blind = await colorSeen(engine, "green", false);
    expect([red.error, green.error, blind.error]).toEqual([null, null, null]);
    expect(red.answer).toMatch(/red/i);
    expect(green.answer).toMatch(/green/i);
    expect(blind.answer).not.toMatch(/green/i);
  }, 600_000);
});
