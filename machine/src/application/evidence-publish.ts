// Publishing an Evidence Pack: its media as release assets on one `luna-evidence` pre-release, a
// section in the PR body, one upserted PR comment. It is what Ship does once the pack is complete
// and its commit is the PR head. Only regular files under the pack's local dir are uploaded, a HAR
// never (it can carry cookies and tokens), and what is written to the PR is flattened by
// `evidence-markdown.ts`. With no GitHub token the pack keeps its local urls and nothing throws.
import type { EvidencePack } from "@hardness/contracts";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";

import { BODY_CAP, COMMENT_MARKER, mergeSection, renderEvidenceComment, renderEvidenceSection, stripSection } from "../domain/evidence-markdown.ts";
import { MAX_MEDIA_BYTES, safeName } from "./evidence-store.ts";
import { type GitHub, GitHubError } from "./github.ts";

export const EVIDENCE_TAG = "luna-evidence";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
};
const contentType = (path: string): string => CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export interface PublishInput {
  github: GitHub;
  slug: string;
  number: number;
  taskId: string;
  pack: EvidencePack;
  /** The pack's local store dir: only files under it are uploaded. */
  localDir: string;
}

export interface Published {
  pack: EvidencePack;
  comment: "created" | "updated" | "skipped";
  /** Whether the PR body got the section; `skipped` when the body left no room for it (the comment still carries the pack). */
  body?: "written" | "skipped";
  assets: number;
}

/** The section needs at least this much of the body's room, else it goes into the comment alone. */
const BODY_ROOM_MIN = 2000;

export type PublishEvidence = (input: PublishInput) => Promise<Published>;

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

/** A local media file that may be uploaded: a regular file, really under `localDir`, within the size cap, not a HAR. */
async function uploadable(path: string, localDir: string): Promise<string | null> {
  if (isWeb(path) || /\.har$/i.test(path)) return null;
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(localDir)]);
    if (!real.startsWith(root + sep)) return null;
    const info = await stat(real);
    return info.isFile() && info.size <= MAX_MEDIA_BYTES ? real : null;
  } catch {
    return null;
  }
}

export const publishEvidence: PublishEvidence = async ({ github, slug, number, taskId, pack, localDir }) => {
  const files = new Map<number, string>();
  for (const [i, m] of pack.media.entries()) {
    const real = await uploadable(m.url, localDir);
    if (real) files.set(i, real);
  }

  // The first call to GitHub decides whether there is a token behind the port at all.
  let release: { id: number } | null = null;
  let current: Awaited<ReturnType<GitHub["prFacts"]>> | undefined;
  try {
    if (files.size > 0) release = await github.ensureRelease(slug, EVIDENCE_TAG, { name: "Luna evidence", prerelease: true });
    else current = await github.prFacts(slug, number);
  } catch (error) {
    if (error instanceof GitHubError) return { pack, comment: "skipped", assets: 0 };
    throw error;
  }

  let uploaded = 0;
  const urls = new Map<number, string>();
  if (release) {
    const existing = new Map((await github.releaseAssets(slug, release.id)).map((a) => [a.name, a.url]));
    for (const [i, real] of files) {
      const name = `${taskId.slice(0, 8)}-${pack.commitSha.slice(0, 7)}-${safeName(basename(real))}`;
      const known = existing.get(name);
      if (known) {
        urls.set(i, known);
        continue;
      }
      const { url } = await github.uploadReleaseAsset(slug, release.id, name, await readFile(real), contentType(real));
      existing.set(name, url);
      urls.set(i, url);
      uploaded++;
    }
  }
  const published: EvidencePack = { ...pack, media: pack.media.map((m, i) => (urls.has(i) ? { ...m, url: urls.get(i)! } : m)) };

  // The body: what the PR says now, minus our old section, plus the new one within what room is left; a body with no room is left alone.
  current ??= await github.prFacts(slug, number);
  const rest = stripSection(current?.body ?? "");
  const room = BODY_CAP - rest.length - 2;
  let body: Published["body"] = "skipped";
  if (room >= BODY_ROOM_MIN) {
    await github.updatePrBody(slug, number, mergeSection(rest, renderEvidenceSection(published, { maxChars: room })));
    body = "written";
  }

  // The comment: ours is the one the token's own user wrote with the marker; anyone else's marker is just text.
  const comment = renderEvidenceComment(published);
  const me = await github.viewer().then((v) => v.login, () => null);
  const found = me === null ? undefined : (await github.listPrComments(slug, number)).find((c) => c.author === me && c.body.includes(COMMENT_MARKER));
  if (found) await github.updateComment(slug, found.id, comment);
  else await github.commentOnIssue(slug, number, comment);
  return { pack: published, comment: found ? "updated" : "created", body, assets: uploaded };
};
