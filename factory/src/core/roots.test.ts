// The allow-roots: every path a tool names, symlinks followed, must lie in the run's roots. The
// reviewer's probes (a glob over the Codex home, /proc's environ files, a symlink in the worktree
// to the login, a write back through a glob) are cases here, against a real filesystem.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type GuardContext, checkCall } from "./guards.ts";

const base = mkdtempSync(join(tmpdir(), "roots-"));
const work = join(base, "work");
const out = join(base, "out");
const scratch = join(base, "luna-scratch");
const codex = join(base, ".codex");
const plugin = join(base, "plugin");
for (const dir of [work, out, scratch, codex, plugin, join(work, "src"), join(work, ".codex"), join(scratch, ".agents", "skills", "tdd")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(codex, "auth.json"), '{"tokens":{}}');
writeFileSync(join(work, "src", "a.ts"), "export {};\n");
writeFileSync(join(work, ".codex", "config.toml"), "model = 'x'\n");
writeFileSync(join(scratch, ".agents", "skills", "tdd", "SKILL.md"), "# tdd\n");
symlinkSync(join(codex, "auth.json"), join(work, "link-to-codex"));
symlinkSync(codex, join(work, "codex-dir"));

const READ_ONLY: GuardContext = {
  writable: false,
  branch: "task/x",
  workRoot: work,
  outRoot: out,
  roots: { scratch, read: [plugin] },
  commands: ["cat", "ls", "head", "echo", "git log", "git diff", "git -C", "gh issue view", "curl", "pnpm", "sh"],
};
const WRITABLE: GuardContext = { ...READ_ONLY, writable: true };

const exec = (command: string, policy = READ_ONLY) => checkCall({ tool: "exec", input: { command } }, policy);
const bash = (command: string, policy = READ_ONLY) => checkCall({ tool: "bash", input: { command } }, policy);
const read = (path: string, extra: Record<string, unknown> = {}, policy = READ_ONLY) => checkCall({ tool: "read", input: { path, ...extra } }, policy);
const write = (path: string, policy = READ_ONLY) => checkCall({ tool: "write", input: { path } }, policy);
const refused = { allow: false, reason: expect.stringMatching(/outside this stage's roots/) };

describe("allow-roots", () => {
  describe("a path outside the roots is refused, whatever names it", () => {
    it.each([
      join(codex, "auth.json"),
      `${base}/./.codex/auth.json`,
      `${base}//.codex/auth.json`,
      `${work}/../.codex/auth.json`,
      "/proc/1/environ",
      "/proc/self/environ",
      "/sys/kernel",
      "/etc/passwd",
      "/dev/tcp/127.0.0.1/80",
      join(tmpdir(), "other-run", "x"),
      "link-to-codex",
      `${work}/link-to-codex`,
      "codex-dir/auth.json",
      "~/.codex/auth.json",
    ])("read %s", (path) => {
      expect(read(path)).toEqual(refused);
    });

    it("refuses a search whose folder or absolute pattern leaves the roots", () => {
      expect(read(codex, { pattern: "*" })).toEqual(refused);
      expect(read(".", { pattern: "/proc/*/environ" })).toEqual(refused);
      expect(read(".", { pattern: "../../**/auth.json" })).toEqual(refused);
    });

    it.each([
      `cat ${codex}/auth.json`,
      "cat /proc/1/environ",
      "head /proc/self/environ",
      "cat link-to-codex",
      "cat codex-dir/auth.json",
      `git -C ${codex} log`,
      `git log --output=${base}/x`,
      `curl file://${codex}/auth.json`,
    ])("exec %j", (command) => {
      expect(exec(command)).toEqual(refused);
    });

    it.each([
      [`echo '{}' > ${base}/.cod*/auth.json`, WRITABLE],
      ["cat /proc/1/environ", READ_ONLY],
      [`cat ${base}/.code?/auth.json`, READ_ONLY],
      [`cat ${base}/.[c]odex/auth.json`, READ_ONLY],
      ["cat link-to-codex", READ_ONLY],
      ["pnpm test > /etc/x", WRITABLE],
      ["cat /dev/tcp/1.2.3.4/80", READ_ONLY],
      [`sh -c 'cat ${codex}/auth.json'`, READ_ONLY],
      ["echo hi > src/a.ts", READ_ONLY],
      ["echo hi >> src/.git/config", WRITABLE],
    ] as const)("bash %j", (command, policy) => {
      expect(bash(command, policy)).toMatchObject({ allow: false });
    });

    it.each([join(codex, "auth.json"), join(tmpdir(), "elsewhere.txt"), `${work}/link-to-codex`, `${work}/codex-dir/config.toml`])("write %s", (path) => {
      expect(write(path, WRITABLE)).toMatchObject({ allow: false });
    });
  });

  describe("everything inside them works", () => {
    it.each([join(work, "src", "a.ts"), "src/a.ts", join(out, "notes.md"), join(scratch, "x.json"), join(plugin, "skills", "tdd", "SKILL.md"), "$HOME/.agents/skills/tdd/SKILL.md", `${work}/.codex/config.toml`, ".codex/config.toml"])("read %s", (path) => {
      expect(read(path)).toEqual({ allow: true });
    });

    it.each(["cat src/a.ts", "cat .codex/config.toml", "ls", "ls .", "git log --oneline -5 -- src/a.ts", "git diff origin/main...HEAD", "gh issue view 12 --repo o/r", "cat /dev/null", "curl -s https://example.com/x"])("exec %j", (command) => {
      expect(exec(command)).toEqual({ allow: true });
    });

    it.each(["pnpm test 2>/dev/null", "pnpm test 2>&1", "pnpm test > out.log", `echo hi > ${out}/x.txt`, "cat src/a.ts | head -5", `curl -s -o ${scratch}/x.tgz https://example.com/x.tgz`])("bash %j", (command) => {
      expect(bash(command, WRITABLE)).toEqual({ allow: true });
    });

    it("writes the worktree in a writable stage, /out and the scratch folder in any", () => {
      expect(write("src/b.ts", WRITABLE)).toEqual({ allow: true });
      expect(write(join(work, ".codex", "config.toml"), WRITABLE)).toEqual({ allow: true });
      expect(write(join(out, "files", "x.md"))).toEqual({ allow: true });
      expect(write(join(scratch, "new", "x.md"))).toEqual({ allow: true });
      expect(write("src/b.ts")).toEqual({ allow: false, reason: expect.stringMatching(/read-only stage/) });
    });

    it("names the scratch folder when it refuses a write to /tmp", () => {
      expect(write(join(tmpdir(), "x.txt"), WRITABLE)).toEqual({ allow: false, reason: expect.stringContaining(scratch) });
    });
  });

  describe("a shell command (Claude's Bash) expands nothing", () => {
    it.each(["echo $(id)", "echo `id`", "cat <(env)", "diff <(ls) >(cat)", "cat /proc/$PPID/environ", "echo ${GH_TOKEN}", "echo $GH_TOKEN", 'echo "$HOME"', "echo $'\\x2f'"])("refuses %j", (command) => {
      expect(bash(command, WRITABLE)).toEqual({ allow: false, reason: expect.stringMatching(/expan|substitution/) });
    });

    it("lets a literal $ through in single quotes, and a credential the stage names", () => {
      expect(bash("echo 'costs $5' '$(id)'", WRITABLE)).toEqual({ allow: true });
      expect(bash('echo "$QA_PASSWORD"', { ...WRITABLE, expandable: ["QA_PASSWORD"] })).toEqual({ allow: true });
      expect(bash('echo "${QA_PASSWORD}"', { ...WRITABLE, expandable: ["QA_PASSWORD"] })).toEqual({ allow: true });
      expect(bash("echo $GH_TOKEN", { ...WRITABLE, expandable: ["QA_PASSWORD"] })).toMatchObject({ allow: false });
    });
  });

  it("leaves paths alone without roots (a host run, the rule tests)", () => {
    const { roots: _r, ...open } = READ_ONLY;
    expect(read("/etc/passwd", {}, open)).toEqual({ allow: true });
    expect(exec("cat /proc/1/environ", open)).toEqual({ allow: true });
  });
});
