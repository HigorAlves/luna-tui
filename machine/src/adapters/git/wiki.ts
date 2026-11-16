// The wiki adapter: a repository's GitHub wiki is a git repository (`<slug>.wiki.git`), so it is read and written with
// host git and the person's own credentials, the way a clone reaches GitHub (application/pulls.ts). One cached checkout
// per repository, synced to the remote's default branch before every call; calls on one slug run one at a time.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WikiError, type Wiki, type WikiPage } from "../../application/wiki.ts";
import { exec } from "../process/exec.ts";
import { gitIdentity, HOST_GIT } from "./worktree.ts";

const GIT_TIMEOUT_MS = 300_000;
/** Git never asks on a terminal: a wiki that wants a login fails with its own words instead of hanging. */
const noPrompt = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

export interface WikiOptions {
  /** Where the checkouts live: `<cacheDir>/<owner>__<name>`. */
  cacheDir: string;
  /** The remote of a repository's wiki. Defaults to `https://github.com/<slug>.wiki.git`. */
  remoteOf?: (slug: string) => string;
  /** Runs after a sync, before the write: a seam for a test to move the remote under the adapter. */
  afterSync?: (slug: string) => Promise<void>;
}

const defaultRemote = (slug: string): string => `https://github.com/${slug}.wiki.git`;

/** The line of git's output that says why, else the first one. */
function whyOf(out: { code: number; stdout: string; stderr: string }): string {
  const lines = `${out.stderr}\n${out.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /rejected|refusing|fatal|error|conflict/i.test(l)) ?? lines[0] ?? `git refused (exit code ${out.code})`;
}

/** A page path the adapter writes: relative, `/` separated, no `..` segment, ending in `.md`. */
function checkPagePath(path: string): void {
  const bad = (why: string) => new WikiError(`not a usable wiki page path ${JSON.stringify(path)}: ${why}`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) throw bad("it must be relative");
  if (path.split("/").some((part) => part === ".." || part === "." || part === "" || part === ".git")) throw bad("no empty, `.`, `..` or `.git` segment");
  if (!path.endsWith(".md")) throw bad("it must end in .md");
}

function checkPrefix(prefix: string): void {
  if (prefix.startsWith("/") || prefix.includes("\\") || prefix.split("/").some((part) => part === ".." || part === ".git")) throw new WikiError(`not a usable wiki prefix ${JSON.stringify(prefix)}`);
}

function checkSlug(slug: string): { owner: string; name: string } {
  const [owner = "", name = "", ...rest] = slug.split("/");
  if (!owner || !name || rest.length || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || owner === ".." || name === "..") throw new WikiError(`not an owner/name repo: "${slug}"`);
  return { owner, name };
}

/** Every `.md` file under `dir`, as paths relative to `root`, skipping `.git`. */
function markdownIn(root: string, dir = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownIn(root, full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full.slice(root.length + 1).split("\\").join("/"));
  }
  return found;
}

export function createWiki(options: WikiOptions): Wiki {
  const remoteOf = options.remoteOf ?? defaultRemote;
  const tails = new Map<string, Promise<unknown>>();

  /** Runs `job` after every earlier call on `slug` has settled. */
  function serial<T>(slug: string, job: () => Promise<T>): Promise<T> {
    const run = (tails.get(slug) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    tails.set(slug, tail);
    void tail.then(() => {
      if (tails.get(slug) === tail) tails.delete(slug);
    });
    return run;
  }

  const git = (repo: string, ...args: string[]) => exec("git", [...HOST_GIT, "-C", repo, ...args], { env: noPrompt(), timeoutMs: GIT_TIMEOUT_MS });
  const gitOrThrow = async (repo: string, ...args: string[]) => {
    const out = await git(repo, ...args);
    if (out.code !== 0) throw new WikiError(whyOf(out));
    return out.stdout.trim();
  };

  /** Brings the checkout for `slug` to the remote's default branch, made on first use. Answers the branch (null for a wiki with no page yet). */
  async function sync(slug: string): Promise<{ repo: string; branch: string | null }> {
    const { owner, name } = checkSlug(slug);
    const repo = join(options.cacheDir, `${owner}__${name}`);
    const remote = remoteOf(slug);
    if (!existsSync(join(repo, ".git"))) {
      mkdirSync(repo, { recursive: true });
      await gitOrThrow(repo, "init", "--quiet");
      await gitOrThrow(repo, "remote", "add", "origin", remote);
    } else {
      await gitOrThrow(repo, "remote", "set-url", "origin", remote);
    }
    const head = await git(repo, "ls-remote", "--symref", "origin", "HEAD");
    if (head.code !== 0) {
      const why = whyOf(head);
      if (/not found|does not appear to be a git repository|does not exist/i.test(head.stderr)) throw new WikiError(`the wiki of ${slug} does not exist yet: open the repo's Wiki tab on GitHub and create the first page`);
      throw new WikiError(why);
    }
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.stdout)?.[1] ?? null;
    if (branch) {
      await gitOrThrow(repo, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
      await gitOrThrow(repo, "checkout", "--quiet", "--force", "-B", branch, `refs/remotes/origin/${branch}`);
      await gitOrThrow(repo, "clean", "--quiet", "-fdx");
    }
    return { repo, branch };
  }

  async function pushTo(repo: string, branch: string): Promise<void> {
    const push = () => git(repo, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    let pushed = await push();
    if (pushed.code === 0) return;
    if (!/rejected|non-fast-forward|fetch first/i.test(pushed.stderr)) throw new WikiError(whyOf(pushed));
    // Someone pushed first: put the commit on their tip once and try again.
    await gitOrThrow(repo, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const rebased = await git(repo, "rebase", "--quiet", `refs/remotes/origin/${branch}`);
    if (rebased.code !== 0) {
      await git(repo, "rebase", "--abort");
      throw new WikiError(whyOf(rebased));
    }
    pushed = await push();
    if (pushed.code !== 0) throw new WikiError(whyOf(pushed));
  }

  return {
    async readPages(slug, prefix) {
      checkSlug(slug);
      checkPrefix(prefix);
      return serial(slug, async () => {
        const { repo } = await sync(slug);
        return markdownIn(repo)
          .filter((path) => path.startsWith(prefix))
          .sort()
          .map((path): WikiPage => ({ path, text: readFileSync(join(repo, path), "utf8") }));
      });
    },

    async writePages(slug, pages, message) {
      checkSlug(slug);
      for (const page of pages) checkPagePath(page.path);
      return serial(slug, async () => {
        const { repo, branch } = await sync(slug);
        await options.afterSync?.(slug);
        for (const page of pages) {
          const file = join(repo, page.path);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, page.text);
        }
        const target = branch ?? "master";
        if (!branch) await gitOrThrow(repo, "symbolic-ref", "HEAD", `refs/heads/${target}`);
        if (pages.length) await gitOrThrow(repo, "add", "--", ...pages.map((p) => p.path));
        const changed = (await git(repo, "diff", "--cached", "--quiet")).code === 1;
        if (changed) {
          const who = await gitIdentity(repo);
          if (!who) throw new WikiError("git has no identity: set user.name and user.email (git config) so the wiki commit is yours");
          await gitOrThrow(repo, "commit", "--quiet", "--no-verify", "-m", message);
          await pushTo(repo, target);
        }
        return { sha: await gitOrThrow(repo, "rev-parse", "HEAD") };
      });
    },
  };
}

const shared = new Map<string, Wiki>();

/** The machine's one wiki for a state dir (cache under `<stateDir>/wikis`): the publisher and the compliance review share it, so
 *  calls on one repo's wiki queue behind one lock and one checkout. */
export function sharedWiki(stateDir: string): Wiki {
  let wiki = shared.get(stateDir);
  if (!wiki) {
    wiki = createWiki({ cacheDir: join(stateDir, "wikis") });
    shared.set(stateDir, wiki);
  }
  return wiki;
}
