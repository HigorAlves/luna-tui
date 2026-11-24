import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { repoSlug } from "../graph/slug.ts";
import { repoSecrets } from "./repo-secrets.ts";

// Values are built at runtime, never written as literals.
const value = (tag: string) => ["val", tag, "x".repeat(12)].join("_");
let home: string;
let repo: string;
let dir: string;

const put = (name: string, text: string, mode = 0o600) => {
  writeFileSync(join(dir, name), text, { mode });
  chmodSync(join(dir, name), mode);
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "secrets-home-"));
  repo = mkdtempSync(join(tmpdir(), "secrets-repo-"));
  dir = join(home, ".config", "hardness", "secrets", repoSlug(repo));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("repoSecrets", () => {
  it("reads a named secret from the owner's folder for that repository, one trailing newline removed", async () => {
    put("QA_PASSWORD", `${value("a")}\n`);
    put("OTHER_KEY", `${value("b")}\n\n`);
    const store = repoSecrets({ home, env: {} });
    const { values, missing } = await store.load(repo, ["QA_PASSWORD", "OTHER_KEY"]);
    expect(values).toEqual({ QA_PASSWORD: value("a"), OTHER_KEY: `${value("b")}\n` });
    expect(missing).toEqual([]);
    expect(store.folder(repo)).toBe(dir);
  });

  it("counts as missing, with a reason that holds no value, a file that is absent, a link, readable by others, or too short", async () => {
    put("GROUP_READ", value("c"), 0o640);
    put("SHORT_ONE", "abc");
    writeFileSync(join(home, "real"), value("d"), { mode: 0o600 });
    symlinkSync(join(home, "real"), join(dir, "LINKED_ONE"));
    const store = repoSecrets({ home, env: {} });
    const out = await store.load(repo, ["GROUP_READ", "SHORT_ONE", "LINKED_ONE", "ABSENT_ONE"]);
    expect(out.values).toEqual({});
    expect(out.missing.map((m) => m.name)).toEqual(["GROUP_READ", "SHORT_ONE", "LINKED_ONE", "ABSENT_ONE"]);
    for (const m of out.missing) for (const v of ["c", "d"]) expect(m.reason).not.toContain(value(v));
    expect(out.missing[0]!.reason).toMatch(/group|others|permission|0600/i);
  });

  it("never reads the machine's own environment, and refuses a name the engines or the machine use", async () => {
    const store = repoSecrets({ home, env: { FROM_ENV_ONLY: value("e"), ANTHROPIC_API_KEY: value("f") } });
    put("ANTHROPIC_API_KEY", value("g"));
    const out = await store.load(repo, ["FROM_ENV_ONLY", "ANTHROPIC_API_KEY"]);
    expect(out.values).toEqual({});
    expect(out.missing.map((m) => m.name)).toEqual(["FROM_ENV_ONLY", "ANTHROPIC_API_KEY"]);
  });

  it("keeps each repository's secrets apart", async () => {
    const other = mkdtempSync(join(tmpdir(), "secrets-other-"));
    const out = await repoSecrets({ home, env: {} }).load(other, ["QA_PASSWORD"]);
    expect(out.values).toEqual({});
    rmSync(other, { recursive: true, force: true });
  });
});
