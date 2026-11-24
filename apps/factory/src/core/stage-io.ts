// The stage's input and the result it leaves when that input is unusable: /in/stage.json is
// read and validated here, and an invalid one still gets a /out/result.json saying why.
import { StageInput } from "@hardness/contracts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** The stage input at `path`, or null once a failed result naming the problem is in `outDir`. */
export function readStageInput(path: string, outDir: string): StageInput | null {
  const parsed = StageInput.safeParse(readJson(path));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  // The machine reads result.json whatever the exit code; a result with the reason beats none.
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ ...skeleton(), error: `invalid stage input: ${issues}` }, null, 2)}\n`);
  process.stderr.write(`factory: invalid stage input at ${path}: ${issues}\n`);
  return null;
}

export function skeleton() {
  return {
    schema: 3,
    ok: false,
    outcome: "fail",
    summary: "",
    needsInput: null,
    requested: [],
    findings: [],
    artifacts: [],
    slices: { done: 0, total: 0 },
    commit: null,
    answer: null,
    usage: { turns: 0, costUsd: null, durationMs: 0, model: "" },
    error: null,
    rateLimited: false,
    resetsAt: null,
    ledger: null,
    sessionId: null,
  };
}
