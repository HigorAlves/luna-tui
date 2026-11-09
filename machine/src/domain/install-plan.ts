// What the machine runs to install a repository's dependencies from its lockfile: one fixed argv per lockfile, no package scripts
// unless the repository turned `sandbox.install.scripts` on. Pure. The lockfile NAMES come from the card's repository at the commit, the
// choices (scripts, yarn berry) from the user's checkout; nothing in the card's folder picks a flag.
// "No scripts" is BEST EFFORT, not a guarantee: a package manager also runs code named by configuration files in the folder. The plan closes
// the ones it can (`--ignore-pnpmfile`, `YARN_IGNORE_PATH`) and application/install.ts refuses an install when the card changes `.npmrc`,
// `.yarnrc` or `.yarnrc.yml` from the repository's own; other tool-specific hooks are not covered, and the install holds no credential and
// no secret and sees only the install list, because it can run code.
import { createHash } from "node:crypto";

import { LOCKFILES } from "./env-hash.ts";

export interface InstallStep {
  lockfile: string;
  tool: string;
  argv: string[];
  env: Record<string, string>;
  /** The step leaves a `node_modules` folder in the work folder (in `dir`, for a subfolder's). */
  node: boolean;
  /** The subfolder it runs in (`tools/web`), for a lockfile below the root; absent at the root. */
  dir?: string;
}

export interface InstallPlan {
  steps: InstallStep[];
  skipped: Array<{ lockfile: string; note: string }>;
}

export interface InstallChoices {
  scripts: boolean;
  /** The user's checkout has a `.yarnrc.yml`. */
  yarnBerry: boolean;
}

const NO_SCRIPT_INSTALL = new Set(["poetry.lock", "Pipfile.lock", "Gemfile.lock"]);

function stepOf(lockfile: string, { scripts, yarnBerry }: InstallChoices): InstallStep | null {
  const flag = (...f: string[]): string[] => (scripts ? [] : f);
  const step = (argv: string[], node = false, env: Record<string, string> = {}): InstallStep => ({ lockfile, tool: argv[0]!, argv, env, node });
  switch (lockfile) {
    case "pnpm-lock.yaml": return step(["pnpm", "install", "--frozen-lockfile", ...flag("--ignore-scripts"), "--ignore-pnpmfile"], true);
    case "package-lock.json": return step(["npm", "ci", ...flag("--ignore-scripts")], true);
    case "yarn.lock": return yarnBerry ? step(["yarn", "install", "--immutable"], true, scripts ? {} : { YARN_ENABLE_SCRIPTS: "false" }) : step(["yarn", "install", "--frozen-lockfile", ...flag("--ignore-scripts")], true, { YARN_IGNORE_PATH: "1" });
    case "bun.lock":
    case "bun.lockb": return step(["bun", "install", "--frozen-lockfile", ...flag("--ignore-scripts")], true);
    case "Cargo.lock": return step(["cargo", "fetch", "--locked"]);
    case "go.sum": return step(["go", "mod", "download"]);
    case "uv.lock": return step(["uv", "sync", "--frozen", "--no-install-project", ...flag("--no-build")]);
    case "composer.lock": return step(["composer", "install", ...(scripts ? [] : ["--no-scripts", "--no-plugins"]), "--no-interaction"]);
    case "poetry.lock": return step(["poetry", "install", "--no-root", "--no-interaction"]);
    case "Pipfile.lock": return step(["pipenv", "sync"]);
    case "Gemfile.lock": return step(["bundle", "install", "--frozen"]);
    default: return null;
  }
}

/** The install for the lockfiles present, in the order of `LOCKFILES`. */
export function installPlanOf(lockfiles: readonly string[], choices: InstallChoices): InstallPlan {
  const present = new Set(lockfiles);
  const steps: InstallStep[] = [];
  const skipped: InstallPlan["skipped"] = [];
  let bun = false;
  for (const name of LOCKFILES) {
    if (!present.has(name)) continue;
    if (name.startsWith("bun.")) {
      if (bun) continue;
      bun = true;
    }
    if (NO_SCRIPT_INSTALL.has(name) && !choices.scripts) {
      skipped.push({ lockfile: name, note: `${name}: no install that runs no package code exists for it; set sandbox.install.scripts: on in luna.yaml to install it (an install script is any code, and it runs with no credential, no secret and the install list)` });
      continue;
    }
    const step = stepOf(name, choices);
    if (step) steps.push(step);
  }
  return { steps, skipped };
}

/** The plans of the lockfiles below the root, one per folder, each as the root's would be (its steps run in that folder, `lockfile` is the
 *  path); folders in path order. `choicesOf` gives a folder's own choices (its `.yarnrc.yml`). */
export function nestedPlansOf(paths: readonly string[], choicesOf: (dir: string) => InstallChoices): InstallPlan {
  const byDir = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) continue;
    const dir = path.slice(0, slash);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.slice(slash + 1)]);
  }
  const steps: InstallStep[] = [];
  const skipped: InstallPlan["skipped"] = [];
  for (const [dir, names] of byDir) {
    const plan = installPlanOf(names, choicesOf(dir));
    steps.push(...plan.steps.map((s) => ({ ...s, lockfile: `${dir}/${s.lockfile}`, dir })));
    skipped.push(...plan.skipped.map((s) => ({ lockfile: `${dir}/${s.lockfile}`, note: `${dir}/${s.note}` })));
  }
  return { steps, skipped };
}

/** The argv that runs `step` in its folder: the folder is an argument, never part of a shell string. */
export function argvIn(step: InstallStep): string[] {
  return step.dir ? ["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "install-in", step.dir, ...step.argv] : step.argv;
}

/** sha256 over the environment hash's own lines for the image id and each lockfile's blob id, and a `scripts:<mode>` line; no commit. */
export function installKey({ image, lockfiles, scripts }: { image: string; lockfiles: Record<string, string>; scripts: "on" | "off" }): string {
  const lines = [`image:${image}`, ...Object.keys(lockfiles).sort().map((name) => `lock:${name}:${lockfiles[name]}`), `scripts:${scripts}`];
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}
