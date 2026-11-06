// The environment a Build ran in, as one hash: the runner image, the lockfiles the repository has at
// that commit, and the commit. Verify computes it again on its fresh clone and compares the parts.
import { createHash } from "node:crypto";

/** The lockfile names the machine reads (npm, pnpm, yarn, bun, Cargo, Go, Poetry, uv, Pipfile, Gemfile, composer). */
export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock"] as const;

export interface EnvInputs {
  image: string;
  lockfiles: Record<string, string>;
  commit: string;
}

/** What a run records: the inputs and their hash. */
export interface EnvRecord extends EnvInputs {
  hash: string;
}

/** sha256 over `image:<id>`, one `lock:<name>:<hash>` line per lockfile by sorted name, and `commit:<sha>`. */
export function envHash({ image, lockfiles, commit }: EnvInputs): string {
  const lines = [`image:${image}`, ...Object.keys(lockfiles).sort().map((name) => `lock:${name}:${lockfiles[name]}`), `commit:${commit}`];
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

export const envOf = (inputs: EnvInputs): EnvRecord => ({ ...inputs, hash: envHash(inputs) });

/** What Verify's environment has that Build's did not: a different image, or at the same commit a lockfile that differs. */
export function compareEnv(recorded: EnvInputs, current: EnvInputs): { matched: boolean; differences: string[] } {
  const differences: string[] = [];
  if (recorded.image !== current.image) differences.push(`the runner image differs: Build ran on ${recorded.image}, Verify on ${current.image}`);
  if (recorded.commit === current.commit) {
    for (const name of [...new Set([...Object.keys(recorded.lockfiles), ...Object.keys(current.lockfiles)])].sort()) {
      if (recorded.lockfiles[name] !== current.lockfiles[name]) differences.push(`${name} differs at the same commit: Build recorded ${recorded.lockfiles[name] ?? "none"}, Verify has ${current.lockfiles[name] ?? "none"}`);
    }
  }
  return { matched: differences.length === 0, differences };
}
