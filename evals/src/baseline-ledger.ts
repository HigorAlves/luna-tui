// Which baseline files the defaults on disk were last written from. `defaults --write` lists the files that changed since: baselines are inputs to the
// rule and need the review code gets, so a person sees what moved before the write lands. The ledger is `evals/.defaults-baselines.json`, written only
// by `defaults --write`. Pure over the folder it reads.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_FILE = ".defaults-baselines.json";

/** `<engine>/<pack>.json` to the sha256 of the file. */
export function baselineHashes(evalsDir: string): Record<string, string> {
  const root = join(evalsDir, "baselines");
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const engine of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(root, engine.name)).filter((f) => f.endsWith(".json"))) out[`${engine.name}/${file}`] = createHash("sha256").update(readFileSync(join(root, engine.name, file))).digest("hex");
  }
  return out;
}

export function readLedger(evalsDir: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(evalsDir, LEDGER_FILE), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function writeLedger(evalsDir: string, hashes: Record<string, string>): void {
  writeFileSync(join(evalsDir, LEDGER_FILE), `${JSON.stringify(hashes, null, 2)}\n`);
}

/** The lines that say which baseline files changed, appeared or went since the last write. */
export function changedLines(previous: Record<string, string> | null, now: Record<string, string>): string[] {
  if (previous === null) return [`no earlier write is recorded: all ${Object.keys(now).length} baseline file(s) are new to this list`];
  const lines = [
    ...Object.keys(now).filter((file) => previous[file] !== undefined && previous[file] !== now[file]).map((file) => `changed since the last write: evals/baselines/${file}`),
    ...Object.keys(now).filter((file) => previous[file] === undefined).map((file) => `new since the last write: evals/baselines/${file}`),
    ...Object.keys(previous).filter((file) => now[file] === undefined).map((file) => `gone since the last write: evals/baselines/${file}`),
  ];
  return lines.length > 0 ? lines : ["no baseline file changed since the last write"];
}
