// The package registries a repository's lockfiles name. The lockfile text comes from the USER's checkout (the
// policy source), never a card's folder: a card editing a lockfile cannot widen its own list. Pure.
import { hostPatternProblem, normalizeHostPattern } from "@hardness/contracts";

const NPM = ["registry.npmjs.org"];
/** Each lockfile name and the hosts its ecosystem installs from. */
const OWN_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "package-lock.json": NPM,
  "pnpm-lock.yaml": NPM,
  "bun.lock": NPM,
  "bun.lockb": NPM,
  "yarn.lock": ["registry.yarnpkg.com", "registry.npmjs.org", "repo.yarnpkg.com"],
  "Cargo.lock": ["index.crates.io", "static.crates.io", "crates.io"],
  "go.sum": ["proxy.golang.org", "sum.golang.org"],
  "poetry.lock": ["pypi.org", "files.pythonhosted.org"],
  "uv.lock": ["pypi.org", "files.pythonhosted.org"],
  "Pipfile.lock": ["pypi.org", "files.pythonhosted.org"],
  "Gemfile.lock": ["rubygems.org", "index.rubygems.org"],
  "composer.lock": ["repo.packagist.org", "packagist.org"],
};
const BINARY = new Set(["bun.lockb"]);
const KEYED = /\b(resolved|url|tarball|remote|source)\b/;
const HTTPS_URL = /https:\/\/[^\s"'<>)\]}\\,]+/g;
export const MAX_REGISTRY_HOSTS = 20;

export interface LockfileText {
  name: string;
  text: string;
}

/** The host a lockfile URL names, as an allow entry, or null: no userinfo, no IP, no local name, and no port but 443. */
function hostOfUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = normalizeHostPattern(url.hostname);
  return hostPatternProblem(host) === null ? host : null;
}

/** Each ecosystem's own hosts for a lockfile that is present (at the root, or by name in `nested`), plus the hosts of the `https://` URLs its text names on a line with `resolved`, `url`, `tarball`, `remote` or `source`; at most 20, sorted. */
export function registryHostsOf(lockfiles: readonly LockfileText[], nested: readonly string[] = []): string[] {
  const own = new Set<string>();
  const named = new Set<string>();
  // A lockfile in a subfolder (`board/Cargo.lock`) adds its ecosystem's own hosts and nothing it names: a vendored or planted lockfile deep in
  // the tree cannot open an arbitrary host. A custom registry it uses is a `sandbox.egress.allow` entry.
  for (const path of nested) for (const h of OWN_HOSTS[path.slice(path.lastIndexOf("/") + 1)] ?? []) own.add(h);
  for (const { name, text } of lockfiles) {
    const hosts = OWN_HOSTS[name];
    if (!hosts) continue;
    for (const h of hosts) own.add(h);
    if (BINARY.has(name)) continue;
    for (const line of text.split("\n")) {
      if (!KEYED.test(line)) continue;
      for (const match of line.match(HTTPS_URL) ?? []) {
        const host = hostOfUrl(match);
        if (host) named.add(host);
      }
    }
  }
  const all = new Set(own);
  for (const host of [...named].sort()) {
    if (all.size >= MAX_REGISTRY_HOSTS) break;
    all.add(host);
  }
  return [...all].sort();
}
