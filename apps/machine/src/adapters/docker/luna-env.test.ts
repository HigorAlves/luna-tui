import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runner");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs `luna-env <argv>` with the secrets folder pointed at a temp dir holding `files`; `none` leaves the folder missing. */
function lunaEnv(files: Record<string, string> | null, argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "luna-env-"));
  dirs.push(dir);
  const secrets = join(dir, "secrets");
  if (files) {
    spawnSync("mkdir", ["-m", "700", secrets]);
    for (const [name, value] of Object.entries(files)) writeFileSync(join(secrets, name), value, { mode: 0o600 });
  }
  return spawnSync("/bin/sh", [join(runner, "luna-env"), ...argv], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", LUNA_SECRETS_DIR: secrets } });
}
const printVar = (name: string) => ["/bin/sh", "-c", `printf %s "$${name}"`];

describe("luna-env", () => {
  it("exports each file as the variable of its name, then runs the command, so code that reads process.env keeps working", () => {
    const out = lunaEnv({ DB_URL: "postgres://u:p@h/db", API_KEY: "k-123" }, printVar("DB_URL"));
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("postgres://u:p@h/db");
    expect(lunaEnv({ API_KEY: "k-123" }, printVar("API_KEY")).stdout).toBe("k-123");
  });

  it("keeps a multi-line value whole and drops only the one trailing newline", () => {
    expect(lunaEnv({ PEM: "-----BEGIN-----\nabc\n-----END-----\n" }, printVar("PEM")).stdout).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(lunaEnv({ NO_NL: "abc" }, printVar("NO_NL")).stdout).toBe("abc");
  });

  it("runs the command as it is when there is no secrets folder", () => {
    const out = lunaEnv(null, ["/bin/sh", "-c", "printf ok"]);
    expect(out).toMatchObject({ status: 0, stdout: "ok", stderr: "" });
  });

  it("passes the command's arguments and its exit code through", () => {
    const out = lunaEnv({ A: "1" }, ["/bin/sh", "-c", 'printf "%s|%s" "$1" "$A"; exit 7', "sh", "arg one"]);
    expect(out.status).toBe(7);
    expect(out.stdout).toBe("arg one|1");
  });

  it("refuses a file whose name is not a variable name, and runs nothing", () => {
    for (const bad of ["my-secret", "1ABC", "A.B", "A B"]) {
      const out = lunaEnv({ GOOD: "g", [bad]: "the-value" }, ["/bin/sh", "-c", "printf RAN"]);
      expect(out.status, bad).not.toBe(0);
      expect(out.stdout, bad).toBe("");
      expect(out.stderr, bad).toContain(bad);
    }
  });

  it("refuses a secret whose name would change how a process loads or where its traffic goes, and runs nothing", () => {
    for (const bad of ["NODE_OPTIONS", "LD_PRELOAD", "LD_ANYTHING", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "PATH", "HOME", "HTTPS_PROXY", "http_proxy", "NO_PROXY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "LUNA_EFFORT", "HARDNESS_TASK"]) {
      const out = lunaEnv({ GOOD: "g", [bad]: "the-value" }, ["/bin/sh", "-c", "printf RAN"]);
      expect(out.status, bad).not.toBe(0);
      expect(out.stdout, bad).toBe("");
      expect(out.stderr, bad).toContain(bad);
      expect(out.stderr, bad).not.toContain("the-value");
    }
    // An engine credential is a secret like any other.
    expect(lunaEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, printVar("CLAUDE_CODE_OAUTH_TOKEN")).stdout).toBe("t");
  });

  it("never prints a value, on success or on refusal", () => {
    const ok = lunaEnv({ TOKEN: "super-secret-value" }, ["/bin/sh", "-c", "true"]);
    expect(ok.stdout + ok.stderr).toBe("");
    const refused = lunaEnv({ TOKEN: "super-secret-value", "bad-name": "super-secret-value" }, ["/bin/sh", "-c", "true"]);
    expect(refused.stdout + refused.stderr).not.toContain("super-secret-value");
  });

  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)("exits non-zero, naming the folder and no value, when the folder exists but cannot be listed, and runs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-env-"));
    dirs.push(dir);
    const secrets = join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "TOKEN"), "super-secret-value", { mode: 0o600 });
    chmodSync(secrets, 0o000);
    try {
      const out = spawnSync("/bin/sh", [join(runner, "luna-env"), "/bin/sh", "-c", "printf RAN"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", LUNA_SECRETS_DIR: secrets } });
      expect(out.status).not.toBe(0);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(secrets);
      expect(out.stderr).not.toContain("super-secret-value");
    } finally {
      chmodSync(secrets, 0o755);
    }
  });

  it.skipIf(asRoot)("exits non-zero, naming the file and no value, when a secret file cannot be read, and runs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-env-"));
    dirs.push(dir);
    const secrets = join(dir, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "GOOD"), "good-value", { mode: 0o644 });
    writeFileSync(join(secrets, "TOKEN"), "super-secret-value", { mode: 0o000 });
    const out = spawnSync("/bin/sh", [join(runner, "luna-env"), "/bin/sh", "-c", "printf RAN"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", LUNA_SECRETS_DIR: secrets } });
    expect(out.status).not.toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("TOKEN");
    expect(out.stderr).not.toContain("super-secret-value");
    expect(out.stderr).not.toContain("good-value");
  });

  it("says how it is used when given no command", () => {
    const out = lunaEnv({ A: "1" }, []);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/usage: luna-env/);
  });
});

describe("the stage's entry and the runner image", () => {
  it("luna-stage starts the factory through luna-env, so the credential is in the environment before node starts", () => {
    expect(readFileSync(join(runner, "luna-stage"), "utf8")).toMatch(/exec \/opt\/luna\/bin\/luna-env \/opt\/luna\/bin\/node /);
  });

  it("luna-env is copied into the image, and is an input of the layer's key", () => {
    expect(readFileSync(join(runner, "Dockerfile"), "utf8")).toMatch(/COPY apps\/machine\/runner\/luna-env \/opt\/luna\/bin\/luna-env/);
    expect(readFileSync(join(runner, "build.sh"), "utf8")).toContain('"$here/luna-env"');
  });
});
