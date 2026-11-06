// Runs packs in the hardened sandbox (read-only root, tmpfs /tmp, no-new-privileges) with
// no machine and no model call: `evidence` is script-only, `implementing` runs as a dry run.
// Run through tsx: `pnpm --filter @hardness/machine smoke:sandbox`. Needs docker and hardness-runner:dev.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runSandbox } from "../src/adapters/docker/docker.ts";
import { ensureClone, refreshScratch } from "../src/adapters/git/clone.ts";
import { at, machineGitDir } from "../src/adapters/git/machine-repo.ts";
import { HOST_GIT } from "../src/adapters/git/worktree.ts";

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
// The host's git on the card: the machine's repository as the git dir, the folder as the work tree.
const hostGit = (...a) => execFileSync("git", [...HOST_GIT, ...at(clone), ...ident, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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

async function sandbox(label, pack, writable, extraEnv, entrypoint, egress) {
  const runDir = join(root, label);
  // The agent's own repository in the folder, made by the machine before every run.
  await refreshScratch(clone, branch);
  const result = await runSandbox({
    name: `smoke-sandbox-${label}-${process.pid}`,
    image,
    runDir,
    worktree: clone,
    writable,
    gitDir: null,
    entrypoint,
    input: stageInput(pack),
    timeoutMs: 120000,
    // Dummy: the dry run and the evidence pack never call the API.
    credential: { env: { ANTHROPIC_API_KEY: "smoke-no-call" }, mounts: [] },
    labels: { "dev.hardness.smoke": label },
    extraEnv,
    ...(egress ? { egress: { ...egress, proxyImage: image } } : {}),
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
  check("evidence: worktree untouched", hostGit("status", "--porcelain") === "", "git status not clean");

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

  // From inside a writable container: nothing of the user's repository or of the machine's is there, the agent's own .git is writable,
  // and whatever it writes there is not what the host's git reads.
  const probe = [
    `[ -e ${repo} ] && echo "repo visible"`,
    `[ -e ${machineGitDir(clone)} ] && echo "machine repository visible"`,
    `(printf '[core]\\n\\tfsmonitor = touch /out/pwned-fsmonitor\\n[filter "x"]\\n\\tclean = touch /out/pwned-filter\\n' >> /work/.git/config) 2>/dev/null && echo "own .git writable"`,
    `echo '* filter=x' > /work/.gitattributes`,
    `echo changed > /work/a-new-file.txt`,
    "true",
  ].join("; ");
  const c = await sandbox("isolation", "implementing", true, undefined, ["sh", "-c", `{ ${probe}; } > /out/probe.txt 2>&1`]);
  const probed = existsSync(join(c.out, "probe.txt")) ? readFileSync(join(c.out, "probe.txt"), "utf8") : "(no probe output)";
  check("isolation: neither the repository nor the machine's repository is mounted", !/visible/.test(probed), probed);
  check("isolation: the agent's own .git is writable (the probe ran)", probed.includes("own .git writable"), probed);
  // The host's git on the card, with the hostile config and attributes in the folder: it runs nothing the container wrote.
  const status = hostGit("status", "--porcelain");
  hostGit("add", "-A");
  check("isolation: the host's git reads the machine's repository, not the folder's .git", status.includes("a-new-file.txt") && !existsSync(join(c.out, "pwned-fsmonitor")) && !existsSync(join(c.out, "pwned-filter")), `status ${status}; markers ${existsSync(join(c.out, "pwned-filter"))}`);

  // The network: a stage on a card network whose list is empty (no proxy) reaches no address and resolves no name.
  const probeNet = [
    `/opt/luna/bin/node -e "const n=require('node:net').connect({host:'1.1.1.1',port:443});n.setTimeout(4000,()=>{console.log('addr:unreachable');n.destroy()});n.on('connect',()=>{console.log('addr:REACHED');n.destroy()});n.on('error',()=>console.log('addr:unreachable'))"`,
    `/opt/luna/bin/node -e "require('node:dns').lookup('off-the-list.example.org',(e)=>console.log(e?'name:unresolved':'name:RESOLVED'))"`,
  ].join("; ");
  const d = await sandbox("network", "implementing", true, undefined, ["sh", "-c", `{ ${probeNet}; } > /out/net.txt 2>&1`], { allow: [], allowPrivate: [] });
  const net = existsSync(join(d.out, "net.txt")) ? readFileSync(join(d.out, "net.txt"), "utf8") : "(no output)";
  check("network: an address off the list is not reachable from a stage", net.includes("addr:unreachable") && !net.includes("REACHED"), net);
  check("network: a name off the list does not resolve", net.includes("name:unresolved") && !net.includes("RESOLVED"), net);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.ok ? "" : r.detail}`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
