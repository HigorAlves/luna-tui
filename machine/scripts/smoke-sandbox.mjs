// Runs packs in the hardened sandbox (read-only root, tmpfs /tmp, no-new-privileges) with
// no machine and no model call: `evidence` is script-only, `implementing` runs as a dry run.
// Run through tsx: `pnpm --filter @hardness/machine smoke:sandbox`. Needs docker and hardness-runner:dev.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runSandbox } from "../src/adapters/docker/docker.ts";
import { ensureClone, sealedPaths } from "../src/adapters/git/clone.ts";

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
// The card's workspace is its own clone: the container sees only it, never the repository's git dir.
const workspace = { branch, path: join(root, "cards", "clone") };
await ensureClone(repo, workspace);
const clone = workspace.path;

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
  env: { LUNA_FACTORY: "1" },
});

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });

async function sandbox(label, pack, writable, extraEnv, entrypoint) {
  const runDir = join(root, label);
  const result = await runSandbox({
    name: `smoke-sandbox-${label}-${process.pid}`,
    image,
    runDir,
    worktree: clone,
    writable,
    gitDir: null,
    workReadOnly: writable ? sealedPaths(clone) : [],
    entrypoint,
    input: stageInput(pack),
    timeoutMs: 120000,
    // Dummy: the dry run and the evidence pack never call the API.
    credential: { env: { ANTHROPIC_API_KEY: "smoke-no-call" }, mounts: [] },
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
  check("evidence: worktree untouched", git(clone, "status", "--porcelain") === "", "git status not clean");

  const b = await sandbox("implementing", "implementing", true, { LUNA_STAGE_DRY_RUN: "1" });
  const resB = readJson(join(b.out, "result.json"));
  check("implementing: exit 0", b.result.exitCode === 0, `exit ${b.result.exitCode}`);
  check("implementing: summary dry-run", resB?.summary === "dry-run", `summary ${resB?.summary}`);
  check("implementing: prompt.md", existsSync(join(b.out, "prompt.md")), "");
  check("implementing: ledger.json", existsSync(join(b.out, "ledger.json")) || resB?.ledger != null, "");
  check("implementing: events.jsonl", existsSync(join(b.out, "events.jsonl")), "");

  if (rows.some((r) => !r.ok)) {
    for (const [l, t] of [["evidence", a.transcript], ["implementing", b.transcript]]) console.log(`--- ${l} transcript ---\n${t}`);
  }

  // From inside a writable container: the repository's git dir is not there, and the clone's config, hooks and info refuse a write.
  const probe = [
    `[ -e ${repo}/.git ] && echo "repo git dir visible"`,
    `[ -e ${repo} ] && echo "repo visible"`,
    ...["config", "hooks/pre-commit", "info/exclude", "objects/info/alternates"].map((f) => `(echo x >> /work/.git/${f}) 2>/dev/null && echo "wrote ${f}"`),
    "(echo ok > /work/.git/refs/heads/probe) 2>/dev/null && echo \"refs of the clone writable\"",
    "true",
  ].join("; ");
  const configBefore = readFileSync(join(clone, ".git", "config"), "utf8");
  const c = await sandbox("isolation", "implementing", true, undefined, ["sh", "-c", `{ ${probe}; } > /out/probe.txt 2>&1`]);
  const probed = existsSync(join(c.out, "probe.txt")) ? readFileSync(join(c.out, "probe.txt"), "utf8") : "(no probe output)";
  check("isolation: the repository is not mounted", !/repo (git dir )?visible/.test(probed), probed);
  check("isolation: config, hooks, info and alternates refuse writes", !/wrote /.test(probed), probed);
  check("isolation: the rest of the clone is writable (the probe ran)", probed.includes("refs of the clone writable"), probed);
  check("isolation: the clone's config is unchanged on the host", readFileSync(join(clone, ".git", "config"), "utf8") === configBefore, "config changed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.ok ? "" : r.detail}`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
