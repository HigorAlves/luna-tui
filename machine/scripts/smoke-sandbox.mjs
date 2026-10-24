// Runs orc packs in the hardened sandbox (read-only root, tmpfs /tmp, no-new-privileges) with
// no machine and no model call: `evidence` is script-only, `implementing` runs with --dry-run.
// Run through tsx: `pnpm --filter @hardness/machine smoke:sandbox`. Needs docker and hardness-runner:dev.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runSandbox } from "../src/sandbox/docker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "..", "fixtures", "golden-task");
const image = process.env.RUNNER_IMAGE ?? "hardness-runner:dev";
const ident = ["-c", "user.name=Smoke", "-c", "user.email=smoke@hardness.local", "-c", "commit.gpgsign=false"];
const git = (cwd, ...a) => execFileSync("git", [...ident, ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const root = mkdtempSync(join(tmpdir(), "smoke-sandbox-"));
const repo = join(root, "repo");
cpSync(fixture, repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");
const branch = "task/smoke-1";
git(repo, "checkout", "-q", "-b", branch);

const stageInput = (pack) => ({
  schema: 1,
  stage: pack,
  pack,
  attempt: 1,
  task: { id: "smoke", title: "smoke", description: "", criteria: [], repoPath: repo, branch, source: null },
  plan: { brief: "", criteria: [], assumptions: [] },
  decisions: [],
  priorFindings: [],
  context: { projectContext: null, tests: [] },
  limits: { maxTurns: 5, timeoutMs: 120000 },
  env: { ORC_FACTORY: "1" },
});

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });

async function sandbox(label, pack, writable, extraEnv) {
  const runDir = join(root, label);
  const result = await runSandbox({
    name: `smoke-sandbox-${label}-${process.pid}`,
    image,
    runDir,
    worktree: repo,
    writable,
    gitDir: join(repo, ".git"),
    input: stageInput(pack),
    timeoutMs: 120000,
    // Dummy: the dry run and the evidence pack never call the API.
    credential: { name: "ANTHROPIC_API_KEY", value: "smoke-no-call" },
    labels: { "dev.hardness.smoke": label },
    extraEnv,
  });
  const transcript = existsSync(result.transcriptPath) ? readFileSync(result.transcriptPath, "utf8") : "";
  return { result, transcript, out: join(runDir, "out") };
}

try {
  const a = await sandbox("evidence", "evidence", false);
  const resA = readJson(join(a.out, "result.json"));
  check("evidence: exit 0", a.result.exitCode === 0, `exit ${a.result.exitCode}`);
  check("evidence: result.json outcome", ["pass", "fail"].includes(resA?.outcome), `outcome ${resA?.outcome}`);
  check("evidence: events.jsonl", existsSync(join(a.out, "events.jsonl")), "");
  // ORC_STATE_DIR is set explicitly by docker.ts, so orc's own read-only self-detection stays quiet.
  check("evidence: worktree untouched", git(repo, "status", "--porcelain") === "", "git status not clean");

  const b = await sandbox("implementing", "implementing", true, { ORC_STAGE_DRY_RUN: "1" });
  const resB = readJson(join(b.out, "result.json"));
  check("implementing: exit 0", b.result.exitCode === 0, `exit ${b.result.exitCode}`);
  check("implementing: summary dry-run", resB?.summary === "dry-run", `summary ${resB?.summary}`);
  check("implementing: prompt.md", existsSync(join(b.out, "prompt.md")), "");
  check("implementing: no read-only notice", !b.transcript.includes("orc-stage: cwd is read-only"), "");

  if (rows.some((r) => !r.ok)) {
    for (const [l, t] of [["evidence", a.transcript], ["implementing", b.transcript]]) console.log(`--- ${l} transcript ---\n${t}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.ok ? "" : r.detail}`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
