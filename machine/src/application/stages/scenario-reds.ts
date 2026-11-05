// What the test writer reported through `scenario_red`: each scenario's failing output, read back from the run's /out. The writer's text is data:
// a scenario id is a plain id or dropped, an output keeps its tail (the failing lines are at the end) and is capped.
import { readMailbox } from "./build-watch.ts";

export const SCENARIO_RED_TAIL = 4096;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function readScenarioReds(outDir: string): Promise<Record<string, string>> {
  // Read as every mailbox file is: no symlink followed, a regular file, bounded.
  const text = await readMailbox(outDir, "scenario-reds.json");
  let parsed: unknown;
  try {
    parsed = text === null ? null : JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).flatMap(([id, output]) => (PLAIN_ID.test(id) && typeof output === "string" ? [[id, output.slice(-SCENARIO_RED_TAIL)]] : [])));
}
