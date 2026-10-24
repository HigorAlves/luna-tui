// Runs one stage inside its container.
//   in:  /in/stage.json, a StageInput from the machine (has `pack`)
//   out: /out/result.json, written by `orc-stage run` (the StageOutput contract)
//   cwd: /work, the task's worktree
// Stdout is a readable transcript; the herdr watch pane follows it with `docker logs -f`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync("/in/stage.json", "utf8"));

let ref = "unknown";
try {
  ref = readFileSync("/orc/.orc-ref", "utf8").trim();
} catch {}
process.stdout.write(`orc ${ref} · pack ${input.pack} (attempt ${input.attempt})\n`);
const child = spawn(
  "orc-stage",
  // ORC_STAGE_DRY_RUN=1 (tooling only, e.g. the sandbox smoke) renders the prompt without a model call.
  ["run", "--in", "/in/stage.json", "--out", "/out", "--plugin-root", "/orc", ...(process.env.ORC_STAGE_DRY_RUN === "1" ? ["--dry-run"] : [])],
  { cwd: "/work", stdio: "inherit", env: { ...process.env, ORC_FACTORY: "1" } },
);
child.on("error", (error) => {
  process.stderr.write(`orc-stage failed to start: ${error.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
