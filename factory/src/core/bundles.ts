// What a run hands back to the machine: its commits, as git bundles in /out/bundles. The agent's own git
// repository in /work/.git is its scratch space; the machine never reads it. It reads these bundles the way it
// would read a fetch from an untrusted server, and only ever moves the card's branch forward with them.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const git = (work: string, args: string[]): string => execFileSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The bundler for one run: the tip the run starts at is read now. `bundle()` writes `<out>/bundles/<n>.bundle`, the range
 * from that tip to HEAD (so the newest bundle holds everything the run committed), through a temporary name so the machine
 * never sees a half-written one. It answers the path, or null when there is nothing new or the repository cannot be read.
 */
export function makeBundler(options: { work: string; out: string }) {
  const readHead = (): string | null => {
    try {
      return git(options.work, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      return null;
    }
  };
  const base = readHead();
  let n = 0;
  let last: string | null = base;
  return {
    base,
    bundle(): string | null {
      const tip = readHead();
      if (!base || !tip || tip === last) return null;
      const dir = join(options.out, "bundles");
      const part = join(dir, `.${n + 1}.part`);
      try {
        mkdirSync(dir, { recursive: true });
        git(options.work, ["bundle", "create", part, `${base}..HEAD`]);
        const done = join(dir, `${++n}.bundle`);
        renameSync(part, done);
        last = tip;
        return done;
      } catch {
        rmSync(part, { force: true });
        return null;
      }
    },
  };
}
