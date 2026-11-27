// What a client asks of one PR on demand, beside the inbox the poller keeps: its detail for a PR
// tab, Ready for review, the open PR of a branch, a search for mentions, and a local branch pushed
// with its PR opened. Every call is a person's click in the client; nothing here runs by itself.
import type { IssueHit, IssueKind, OpenPrInput, PrDetail, PrLink } from "@hardness/contracts";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { fromGraphQl } from "../domain/pull-request.ts";
import type { GitHub } from "./github.ts";
import { NoPullError } from "./pulls.ts";

/** A folder the machine cannot see: only checkouts under its repositories folder are mounted into it. */
export class OutsideReposError extends Error {
  constructor(path: string, reposDir: string) {
    super(`"${path}" is not under ${reposDir}, the folder the machine can see`);
    this.name = "OutsideReposError";
  }
}

/** git refused the push; its words ride along. */
export class PushFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushFailedError";
  }
}

export interface PrDeskOptions {
  github: GitHub;
  /** The repositories folder mounted into the machine (`MACHINE_REPOS_DIR`): a path must resolve inside it. */
  reposDir: string;
  /** Poll the inbox again after a change the client wants to see (Ready for review). */
  repoll?: () => Promise<unknown>;
  /** `owner/name` of a checkout's origin, or null when it has none on GitHub. */
  originOf?: (cwd: string) => Promise<string | null>;
  /** Pushes `branch` from `cwd`; answers git's error, or null when it pushed. */
  push?: (branch: string, cwd: string) => Promise<string | null>;
}

/** The port the HTTP routes call; the class and a test fake both fit. */
export interface PrDeskPort {
  detail(repo: string, number: number): Promise<PrDetail>;
  ready(repo: string, number: number): Promise<void>;
  lookup(repo: string, branch: string): Promise<PrLink | null>;
  search(repo: string, kind: IssueKind, query: string): Promise<IssueHit[]>;
  openPr(input: OpenPrInput): Promise<PrLink>;
  /** Throws OutsideReposError unless `path` resolves to the repositories folder or inside it; answers the resolved path. */
  inside(path: string): Promise<string>;
}

export class PrDesk implements PrDeskPort {
  constructor(private readonly options: PrDeskOptions) {}

  async detail(repo: string, number: number): Promise<PrDetail> {
    const { github } = this.options;
    const [node, me] = await Promise.all([github.prFacts(repo, number), github.viewer()]);
    if (!node) throw new NoPullError(repo, number);
    const [merged, threads, reviews, files] = await Promise.all([
      github.prMerged(repo, number),
      github.prThreads(repo, number, { includeResolved: true }),
      github.prReviews(repo, number),
      github.prFiles(repo, number),
    ]);
    return {
      repo,
      number,
      state: merged.merged ? "merged" : merged.state,
      facts: fromGraphQl(node, repo, me.login, me.teams),
      threads: threads.map((t) => ({
        id: t.id,
        path: t.path,
        line: t.line,
        resolved: t.resolved ?? false,
        outdated: t.outdated ?? false,
        comments: t.comments.map((c) => ({ author: c.author, body: c.body, at: c.at })),
      })),
      reviews: reviews.map((r) => ({ author: r.author, state: r.state, at: r.at })),
      files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, ...(f.previousPath ? { previousPath: f.previousPath } : {}) })),
    };
  }

  async ready(repo: string, number: number): Promise<void> {
    await this.options.github.markPrReady(repo, number);
    await this.options.repoll?.();
  }

  lookup(repo: string, branch: string): Promise<PrLink | null> {
    return this.options.github.findPr(repo, branch);
  }

  search(repo: string, kind: IssueKind, query: string): Promise<IssueHit[]> {
    return this.options.github.searchIssues(repo, kind, query);
  }

  async openPr(input: OpenPrInput): Promise<PrLink> {
    const cwd = await this.inside(input.path);
    const { originOf, push } = this.options;
    if (!originOf || !push) throw new PushFailedError("this machine cannot push: no git is wired to the PR desk");
    const slug = await originOf(cwd);
    if (!slug) throw new PushFailedError(`"${input.path}" has no GitHub origin to push to`);
    const failed = await push(input.branch, cwd);
    if (failed) throw new PushFailedError(failed);
    const open = await this.options.github.findPr(slug, input.branch);
    if (open) return open;
    return this.options.github.openPr(slug, { title: input.title, body: input.body, head: input.branch, draft: input.draft, ...(input.base ? { base: input.base } : {}) });
  }

  async inside(path: string): Promise<string> {
    const { reposDir } = this.options;
    if (!isAbsolute(path)) throw new OutsideReposError(path, reposDir);
    // Both sides resolved, so a symlink under the folder that points out of it is out.
    const [real, root] = await Promise.all([realpath(path).catch(() => null), realpath(reposDir).catch(() => reposDir)]);
    if (real === null) throw new OutsideReposError(path, reposDir);
    const rel = relative(root, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OutsideReposError(path, reposDir);
    return real;
  }
}
