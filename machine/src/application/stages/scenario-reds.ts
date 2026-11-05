// What the test writer reported through `scenario_red`: each scenario's failing output, read back from the run's /out. The writer's text is data:
// a scenario id is a plain id or dropped, an output keeps its tail (the failing lines are at the end) and is capped.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SCENARIO_RED_TAIL = 4096;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function readScenarioReds(outDir: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(outDir, "checks", "scenario-reds.json"), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).flatMap(([id, output]) => (PLAIN_ID.test(id) && typeof output === "string" ? [[id, output.slice(-SCENARIO_RED_TAIL)]] : [])));
}
