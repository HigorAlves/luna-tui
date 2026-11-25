// A red test for new code fails because the code is not there yet: on a card that creates a lambda or a package, a scenario's test cannot
// even import what it tests ("Cannot find module 'apps/lambdas/evaluation/src/app'"). That is the right reason, though red_check reads an
// import error as a wrong one. When the module is one the approved plan creates (a touchpoint, or inside a touchpoint folder), or an
// export the plan adds to a package whose package.json it touches, the machine says so itself and asks no judge. Pure.
import { posix } from "node:path";

const MISSING_MODULE = /Cannot find (?:module|package) ['"]([^'"]+)['"](?:\s+imported from\s+(\S+))?/;
// The package by its name (`@discover/ui`) or, as Node prints it, by its folder (`/work/node_modules/@discover/ui`).
const MISSING_EXPORT = /["']([^"']+)["'] is not exported\b[^\n]*?\bfrom package\s+(?:\S*\/node_modules\/)?(@?[\w.-]+(?:\/[\w.-]+)?)/;

const EXISTS_FALSE = /(\S+\.[\w]+)\s+exists:\s+expected false to be true/;
// ENOENT on a file under the container's checkout (/work/...) or a repo-relative one.
const ENOENT = /ENOENT[^\n]*?['"]((?:\/work\/)?[\w@.-][^'"\n]*)['"]/;
const clean = (path: string): string => posix.normalize(path.replace(/\\/g, "/")).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
const noExt = (path: string): string => path.replace(/\.(?:m?[jt]sx?|c[jt]s)$/, "");

/** Whether `path` is a touchpoint (ignoring the extension) or sits inside a touchpoint folder. */
function planned(path: string, touchpoints: readonly string[]): boolean {
  if (!path || path.startsWith("..") || path.startsWith("/")) return false;
  const bare = noExt(path);
  return touchpoints.some((raw) => {
    const t = clean(raw);
    if (!t || t.startsWith("..")) return false;
    return noExt(t) === bare || path.startsWith(`${t}/`);
  });
}

/** The planned path a failing output is missing, or null when the failure is anything else (the judge decides those). */
export function plannedMissingModule(output: string, touchpoints: readonly string[]): string | null {
  const missing = MISSING_MODULE.exec(output);
  if (missing) {
    const spec = missing[1]!;
    const importer = missing[2] ? clean(missing[2]) : null;
    // A bare package name (`lodash-es`, `node:fs`) is a dependency, never a planned file; anything with a folder in it only counts when it
    // lands on a touchpoint below, so a package subpath (`lodash/fp`, `@scope/x`) is left to the judge by the plan, not by its shape.
    if (!spec.startsWith(".") && !spec.includes("/")) return null;
    const candidates = new Set<string>();
    if (importer && spec.startsWith(".")) {
      // `./routes/forms.routes` from `apps/x/src/app.test.ts`: next to the test.
      candidates.add(clean(posix.join(posix.dirname(importer), spec)));
    } else if (importer && spec.startsWith("/")) {
      // `/src/app` from `apps/x/src/a.test.ts`: the root of the importer's package, as a bundler alias resolves it.
      const pkgRoot = /^(.*?)\/src\//.exec(importer)?.[1];
      if (pkgRoot) candidates.add(clean(posix.join(pkgRoot, spec.slice(1))));
    }
    if (!spec.startsWith(".")) candidates.add(clean(spec.replace(/^\//, "")));
    for (const candidate of candidates) if (planned(candidate, touchpoints)) return candidate;
    return null;
  }
  // The writer's own guard: `expect(existsSync(path), "<path> exists").toBe(true)`, or a read of the file that is not there yet.
  const absent = EXISTS_FALSE.exec(output) ?? ENOENT.exec(output);
  if (absent) {
    const path = clean(absent[1]!.replace(/^\/work\//, ""));
    return planned(path, touchpoints) ? path : null;
  }
  const notExported = MISSING_EXPORT.exec(output);
  if (notExported) {
    // The package by its folder name: `@discover/ui` → a touched `…/ui/package.json`.
    const name = notExported[2]!.split("/").at(-1)!;
    const manifest = touchpoints.map(clean).find((t) => t.endsWith(`/${name}/package.json`) || t === `${name}/package.json`);
    return manifest ?? null;
  }
  return null;
}
