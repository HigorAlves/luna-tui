import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { envHash } from "./env-hash.ts";
import { argvIn, installKey, installPlanOf, nestedPlansOf } from "./install-plan.ts";

const plan = (lockfiles: string[], scripts = false, yarnBerry = false) => installPlanOf(lockfiles, { scripts, yarnBerry });
const argvs = (lockfiles: string[], scripts = false, yarnBerry = false) => plan(lockfiles, scripts, yarnBerry).steps.map((s) => s.argv.join(" "));

describe("installPlanOf", () => {
  it("gives one fixed argv per lockfile, with no package scripts", () => {
    expect(argvs(["pnpm-lock.yaml"])).toEqual(["pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile"]);
    expect(argvs(["package-lock.json"])).toEqual(["npm ci --ignore-scripts"]);
    expect(argvs(["yarn.lock"])).toEqual(["yarn install --frozen-lockfile --ignore-scripts"]);
    expect(argvs(["bun.lock"])).toEqual(["bun install --frozen-lockfile --ignore-scripts"]);
    expect(argvs(["Cargo.lock"])).toEqual(["cargo fetch --locked"]);
    expect(argvs(["go.sum"])).toEqual(["go mod download"]);
    expect(argvs(["uv.lock"])).toEqual(["uv sync --frozen --no-install-project --no-build"]);
    expect(argvs(["composer.lock"])).toEqual(["composer install --no-scripts --no-plugins --no-interaction"]);
  });

  it("ignores the card's pnpmfile always, and a yarn classic's own yarnPath, scripts on or off", () => {
    for (const scripts of [false, true]) {
      expect(argvs(["pnpm-lock.yaml"], scripts)[0]).toContain("--ignore-pnpmfile");
      expect(plan(["yarn.lock"], scripts).steps[0]!.env).toMatchObject({ YARN_IGNORE_PATH: "1" });
    }
    expect(plan(["package-lock.json"]).steps[0]!.env).toEqual({});
  });

  it("uses yarn's immutable install and turns scripts off by environment when the checkout is yarn berry", () => {
    const { steps } = plan(["yarn.lock"], false, true);
    expect(steps[0]!.argv).toEqual(["yarn", "install", "--immutable"]);
    expect(steps[0]!.env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });

  it("leaves the script flags out when sandbox.install.scripts is on", () => {
    expect(argvs(["pnpm-lock.yaml", "package-lock.json", "uv.lock", "composer.lock"], true)).toEqual(["npm ci", "pnpm install --frozen-lockfile --ignore-pnpmfile", "uv sync --frozen --no-install-project", "composer install --no-interaction"]);
    expect(plan(["yarn.lock"], true, true).steps[0]).toMatchObject({ argv: ["yarn", "install", "--immutable"], env: {} });
  });

  it("skips poetry, pipenv and bundler with scripts off, naming the key, and installs them with scripts on", () => {
    const off = plan(["poetry.lock", "Pipfile.lock", "Gemfile.lock"]);
    expect(off.steps).toEqual([]);
    expect(off.skipped.map((s) => s.lockfile)).toEqual(["poetry.lock", "Pipfile.lock", "Gemfile.lock"]);
    for (const s of off.skipped) expect(s.note).toContain("sandbox.install.scripts");
    expect(plan(["poetry.lock", "Pipfile.lock", "Gemfile.lock"], true).steps.map((s) => s.argv[0])).toEqual(["poetry", "pipenv", "bundle"]);
  });

  it("is one step for bun's two lockfiles, in the lockfile list's order, and ignores a name that is not a lockfile", () => {
    expect(argvs(["bun.lockb", "bun.lock"])).toHaveLength(1);
    expect(argvs(["go.sum", "package.json", "pnpm-lock.yaml"])).toEqual(["pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile", "go mod download"]);
  });

  it("marks the Node steps, which are the ones whose result is a node_modules folder", () => {
    expect(plan(["pnpm-lock.yaml", "Cargo.lock"]).steps.map((s) => s.node)).toEqual([true, false]);
  });
});

describe("installKey", () => {
  const inputs = { image: "sha256:abc", lockfiles: { "pnpm-lock.yaml": "blob1" }, scripts: "off" as const };
  it("is a sha256 that changes with the image, a lockfile's blob and the scripts mode, and has no commit in it", () => {
    const key = installKey(inputs);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(installKey({ ...inputs })).toBe(key);
    expect(installKey({ ...inputs, image: "sha256:def" })).not.toBe(key);
    expect(installKey({ ...inputs, lockfiles: { "pnpm-lock.yaml": "blob2" } })).not.toBe(key);
    expect(installKey({ ...inputs, scripts: "on" })).not.toBe(key);
  });

  it("leaves the environment hash exactly what it was, and the key is the hash of the same lines without the commit", () => {
    const literal = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(envHash({ image: "sha256:abc", lockfiles: { "pnpm-lock.yaml": "blob1" }, commit: "c0ffee" })).toBe(literal("image:sha256:abc\nlock:pnpm-lock.yaml:blob1\ncommit:c0ffee\n"));
    expect(installKey(inputs)).toBe(literal("image:sha256:abc\nlock:pnpm-lock.yaml:blob1\nscripts:off\n"));
  });
});

describe("nestedPlansOf: lockfiles below the root", () => {
  it("plans each folder as the root would be planned, in path order, with the path as the lockfile and the folder's own choices", () => {
    const plan = nestedPlansOf(["web/yarn.lock", "board/Cargo.lock", "Cargo.lock", "svc/poetry.lock"], (dir) => ({ scripts: false, yarnBerry: dir === "web" }));
    expect(plan.steps.map((s) => [s.dir, s.lockfile, s.argv.join(" ")])).toEqual([
      ["board", "board/Cargo.lock", "cargo fetch --locked"],
      ["web", "web/yarn.lock", "yarn install --immutable"],
    ]);
    expect(plan.skipped.map((s) => s.lockfile)).toEqual(["svc/poetry.lock"]);
  });

  it("runs a folder's step through sh with the folder as an argument; a root step as it is", () => {
    const [step] = nestedPlansOf(["a b/$(x)/Cargo.lock"], () => ({ scripts: false, yarnBerry: false })).steps;
    expect(argvIn(step!)).toEqual(["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "install-in", "a b/$(x)", "cargo", "fetch", "--locked"]);
    expect(argvIn({ lockfile: "Cargo.lock", tool: "cargo", argv: ["cargo", "fetch"], env: {}, node: false })).toEqual(["cargo", "fetch"]);
  });
});
