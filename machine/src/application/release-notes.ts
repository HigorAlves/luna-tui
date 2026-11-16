// On-demand release notes (RFC 0008, wave 6). The PRs merged since the last release go to the `release_notes` pack; its
// answer becomes a draft aimed at the release, which waits for the person. An approve sets the release's body.
import { ReleaseNotesAnswer, type ComplianceDraft, type ReleaseNotesContext } from "@hardness/contracts";

import { releaseNotesText } from "../domain/release-notes.ts";
import type { ComplianceDrafts, TargetWriter } from "./compliance-drafts.ts";
import type { GitHub } from "./github.ts";

/** What a PR body may be, and how many PRs go to the writer: what `ReleaseNotesContext` allows. */
const BODY_CAP = 2000;
const PR_CAP = 200;
const DEFAULT_DAYS = 30;

export interface ReleaseNotesDeps {
  github: Pick<GitHub, "mergedPrs" | "latestRelease" | "recentReleases">;
  drafts: Pick<ComplianceDrafts, "open">;
  /** The one run of the `release_notes` pack; its answer is validated here. */
  write(context: ReleaseNotesContext): Promise<unknown>;
  now?: () => Date;
}

export class ReleaseNotes {
  private readonly now: () => Date;

  constructor(private readonly deps: ReleaseNotesDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The date of the release the notes follow: the latest one, or the one before it when `tag` is itself already the latest (CI published it). */
  private async sinceLastRelease(repo: string, tag: string): Promise<string | null> {
    const latest = await this.deps.github.latestRelease(repo);
    if (latest === null) return null;
    if (latest.tag !== tag) return latest.publishedAt;
    return (await this.deps.github.recentReleases(repo)).find((r) => r.tag !== tag)?.publishedAt ?? null;
  }

  /** The draft for one repository and tag, opened or refreshed. `since` is the date of the release before the tag unless given, else thirty days back. */
  async draft(input: { repo: string; tag: string; since?: string }): Promise<ComplianceDraft> {
    const { github } = this.deps;
    const until = this.now();
    const since = input.since ?? (await this.sinceLastRelease(input.repo, input.tag)) ?? new Date(until.getTime() - DEFAULT_DAYS * 86_400_000).toISOString();
    const merged = await github.mergedPrs(input.repo, since, until.toISOString());
    const prs = merged.slice(-PR_CAP).map((pr) => ({ number: pr.number, title: pr.title, author: pr.author, body: pr.body.slice(0, BODY_CAP), url: pr.url }));
    const answer = ReleaseNotesAnswer.parse(await this.deps.write({ repo: input.repo, tag: input.tag, since, prs }));
    return this.deps.drafts.open({
      id: `release_notes:${input.repo}:${input.tag}`,
      kind: "release_notes",
      repo: input.repo,
      title: `Release notes, ${input.repo} ${input.tag}`,
      period: null,
      summary: `${prs.length} PRs`,
      text: releaseNotesText(answer, new Set(prs.map((pr) => pr.number))),
      targets: [{ kind: "github_release", repo: input.repo, tag: input.tag }],
    });
  }
}

/** The `github_release` target: the release named by the tag (a draft is made when there is none), its body set to the approved text. Safe to repeat. */
export function githubReleaseWriter(github: Pick<GitHub, "ensureRelease" | "updateReleaseBody">): TargetWriter<"github_release"> {
  return async (draft, target) => {
    const release = await github.ensureRelease(target.repo, target.tag, { name: target.tag, prerelease: false });
    await github.updateReleaseBody(target.repo, release.id, draft.text);
  };
}
