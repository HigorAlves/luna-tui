// The control plane of a repo: the files that decide who may change what and what runs on a change (CI, ownership, the machine's own
// config, the lockfiles). A plan that touches one is a high-risk plan, whatever its ticket reads like. Pure.

const NAMES = new Set(["CODEOWNERS", "luna.yaml", "PIPELINE.md", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Gemfile.lock", "composer.lock", ".gitlab-ci.yml", "Jenkinsfile"]);
const DIRECTORIES = [".github/", ".circleci/"];

export function isControlPlane(path: string): boolean {
  const plain = path.replace(/^(\.\/)+/, "");
  if (DIRECTORIES.some((dir) => plain.startsWith(dir))) return true;
  return NAMES.has(plain.split("/").at(-1) ?? "");
}

/** The control-plane files among `paths`, each once, in the order given. */
export const controlPlaneFiles = (paths: readonly string[]): string[] => [...new Set(paths.filter(isControlPlane))];
