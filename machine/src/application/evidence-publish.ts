// Publishing an Evidence Pack: its media as release assets on one `luna-evidence` pre-release, a
// section in the PR body, one upserted PR comment. It is what Evidence (and Ship, on the other paths) does once the pack is complete
// and its commit is the PR head. Media go to the repository's storage target (a port). Only regular files under the pack's local dir are uploaded, a HAR
// never (it can carry cookies and tokens), a text file only after `redact`, within its cap and with no finding (secret, personal data), an image or a video nobody checked only after a person approved, and what is written to the PR is flattened by
// `evidence-markdown.ts`. With no GitHub token the pack keeps its local urls and nothing throws.
import type { EvidencePack } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

import { findingKinds } from "../../runner-video/tools/lib/findings.ts";
import { hashRegularFile, readRegularBytes } from "../adapters/fs/bounded.ts";
import { releaseAssetStorage, EVIDENCE_TAG as TAG } from "../adapters/evidence-storage/release-asset.ts";
import { BODY_CAP, COMMENT_MARKER, mergeSection, redact, renderEvidenceComment, renderEvidenceSection, sectionOf, stripSection } from "../domain/evidence-markdown.ts";
import { type EvidenceStorage, localStorage } from "./evidence-storage.ts";
import { truthName, writeTruthFile } from "./ground-truth.ts";
import { type TruthSink, e2eCompareTruth } from "./decision-truth.ts";
import { emptyCursor, loadCursor, saveCursor } from "./ship-cursor.ts";
import { packComplete, repairPack } from "../domain/evidence-pack.ts";
import { MAX_MEDIA_BYTES } from "./evidence-store.ts";
import { type GitHub, GitHubError } from "./github.ts";

export const EVIDENCE_TAG = TAG;

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
  /** The repository's `evidence.storage`; absent, the draft pre-release of the repository through `github`. */
  storage?: EvidenceStorage;
  /** The card's repository: `publishChosen` reads its `evidence.storage`. */
  repoPath?: string | null;
  /** A person approved the preview gate: an image nobody read (`scanned: false`) may then be uploaded. */
  approved?: boolean;
}

export interface Published {
  pack: EvidencePack;
  comment: "created" | "updated" | "skipped";
  /** Whether the PR body got the section; `skipped` when the body left no room for it (the comment still carries the pack). */
  body?: "written" | "skipped";
  assets: number;
  /** What was kept local and why (an unreadable text, a url that did not resolve): ids and names only. */
  notes?: string[];
}

/** The section needs at least this much of the body's room, else it goes into the comment alone. */
const BODY_ROOM_MIN = 2000;
/** A text media file is read whole to be redacted: over this it is not published. */
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set([".txt", ".log", ".json", ".vtt", ".srt", ".md", ".csv", ".jsonl", ".ndjson"]);

export type PublishEvidence = (input: PublishInput) => Promise<Published>;

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);
/** A url a storage target returned that may be printed as a link. */
const safeUrl = (url: string): boolean => /^https:\/\//.test(url) && !/[\s)<>]/.test(url);

/** A local media file that may be uploaded: a regular file, really under `localDir`, within the size cap, not a HAR. */
async function uploadable(path: string, localDir: string, kind: string): Promise<string | null> {
  if (isWeb(path) || kind === "har" || /\.har$/i.test(path)) return null;
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(localDir)]);
    if (!real.startsWith(root + sep)) return null;
    const info = await stat(real);
    return info.isFile() && info.size <= MAX_MEDIA_BYTES ? real : null;
  } catch {
    return null;
  }
}

export const publishEvidence: PublishEvidence = async ({ github, slug, number, taskId, pack, localDir, storage: chosen, approved = false }) => {
  const storage = chosen ?? releaseAssetStorage(github);
  const notes: string[] = [];
  const files = new Map<number, { real: string; data?: Buffer }>();
  for (const [i, m] of pack.media.entries()) {
    const real = await uploadable(m.url, localDir, m.kind);
    if (!real) continue;
    // Nobody saw an image before it is public: one whose text was not read waits for a person.
    if (m.kind === "screenshot" && m.scanned === false && !approved) {
      notes.push(`${m.label} stays a local copy: its text was not read`);
      continue;
    }
    // A video is uploaded only when its frames were checked (the film's own check, `scanned: true`) or a person approved; the browser run's raw recording carries neither.
    if (m.kind === "video" && m.scanned !== true && !approved) {
      notes.push(`${m.label} stays a local copy: its frames were not checked`);
      continue;
    }
    // A text file is test output or a model's words: redacted whole, read through the bounded reader; one that cannot be read is not published.
    if (m.kind === "report" || m.kind === "captions" || TEXT_EXT.has(extname(real).toLowerCase())) {
      try {
        const text = (await readRegularBytes(real, TEXT_MAX_BYTES)).toString("utf8");
        // The same findings check as a picture's text, whatever the approval: a hit stays local, in fixed words.
        if (findingKinds(text).length > 0) notes.push(`${m.label} stays a local copy: it may hold a secret or personal data`);
        else files.set(i, { real, data: Buffer.from(redact(text), "utf8") });
      } catch {
        notes.push(`${m.label} stays a local copy: it could not be read within its cap`);
      }
      continue;
    }
    files.set(i, { real });
  }

  // The first call to the target decides whether there is a token behind the port at all.
  let current: Awaited<ReturnType<GitHub["prFacts"]>> | undefined;
  const urls = new Map<number, string>();
  const fresh = new Set<number>();
  let started = false;
  try {
    if (files.size === 0) current = await github.prFacts(slug, number);
    // A probe: a target with no token behind it refuses here, before anything is uploaded; a refusal later is a real failure.
    else await storage.has(slug, "");
    started = true;
    for (const [i, file] of files) {
      const digest = file.data ? createHash("sha256").update(file.data).digest("hex") : await hashRegularFile(file.real, MAX_MEDIA_BYTES).catch(() => null);
      if (!digest) continue;
      // From the task, the commit, the digest and an extension of letters and digits: nothing a container or a model wrote.
      const ext = /^\.[a-z0-9]{1,8}$/.exec(extname(file.real).toLowerCase())?.[0] ?? "";
      const name = `${taskId.slice(0, 8)}-${pack.commitSha.slice(0, 7)}-${digest.slice(0, 8)}${ext}`;
      const put = await storage.put({ slug, name, path: file.real, contentType: contentType(file.real), ...(file.data ? { data: file.data } : {}) });
      if (!put) continue;
      if (!safeUrl(put.url)) {
        notes.push(`${pack.media[i]!.label} stays a local copy: the target gave no usable link`);
        continue;
      }
      urls.set(i, put.url);
      if (!put.reused) fresh.add(i);
    }
    for (const [i, url] of [...urls]) {
      if (!(await storage.has(slug, url))) {
        urls.delete(i);
        notes.push(`${pack.media[i]!.label} stays a local copy: its link does not resolve`);
      }
    }
  } catch (error) {
    if (error instanceof GitHubError && !started) return { pack, comment: "skipped", assets: 0, notes };
    throw error;
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
  return { pack: published, comment: found ? "updated" : "created", body, assets: [...fresh].filter((i) => urls.has(i)).length, notes };
};

/** `publishEvidence` on the target the repository chose (`evidence.storage`: `release_asset`, the default, or `local`). */
export const publishChosen = (kindOf: (repoPath: string | null) => Promise<"release_asset" | "local">): PublishEvidence => async (input) =>
  publishEvidence({ ...input, storage: (await kindOf(input.repoPath ?? null).catch(() => "release_asset" as const)) === "local" ? localStorage() : releaseAssetStorage(input.github) });

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface ReadyDeps {
  github: GitHub;
  publish: PublishEvidence;
  /** Saves the pack, with its urls, on the task. */
  save: (taskId: string, pack: EvidencePack) => Promise<void>;
  /** Where the ship cursor lives; absent, no cursor is written. */
  stateDir?: string;
  /** The pack's own local dir for a commit. */
  localDir: (taskId: string, sha: string) => string;
  exists?: (path: string) => boolean;
  /** Where a fact about an earlier decision is taught (the evidence_valid compare); absent, nothing is taught. */
  truth?: TruthSink | null;
}

export type Ready =
  | { published: true; pack: EvidencePack; comment: "created" | "updated"; assets: number; readied: boolean; notes: string[]; /** A person had edited the section the machine last published: it was kept in the ground truth before being replaced. The caller emits `evidence.edited`. */ edited?: { sha: string; bytes: number } }
  | { published: false; reason: string; pack: EvidencePack };

/** Publishes a complete pack onto the PR whose head on GitHub is `headSha`, saves it, records that it was published at this head, and marks a draft PR ready.
 *  The pack is checked first and repaired once by script; one whose commit is not the head, or that is still incomplete, is not published (the reason says why). */
export async function publishAndReady(deps: ReadyDeps, input: { task: { id: string; repoPath: string | null }; slug: string; number: number; headSha: string; draft: boolean; pack: EvidencePack; approved: boolean }): Promise<Ready> {
  const { task, slug, number, headSha, draft, approved } = input;
  let pack = input.pack;
  const checked = packComplete(pack, headSha, deps.exists);
  if (!checked.ok) {
    const fixed = repairPack(pack, checked.problems, deps.exists);
    const after = packComplete(fixed.pack, headSha, deps.exists);
    if (fixed.unfixed.length > 0 || !after.ok) return { published: false, reason: `the pack is not complete: ${[...fixed.unfixed, ...after.problems].join("; ")}`, pack: input.pack };
    pack = fixed.pack;
  }
  // A person's edit of the section is data worth keeping: compared with the hash saved at the last publish (a cursor with none records nothing), stored, then replaced.
  let edited: { sha: string; bytes: number } | undefined;
  const before = deps.stateDir ? await loadCursor(deps.stateDir, task.id) : null;
  if (deps.stateDir && before?.publishedSection) {
    const current = sectionOf((await deps.github.prFacts(slug, number).catch(() => null))?.body ?? "");
    if (current !== null && sha256(current) !== before.publishedSection) {
      const sha = pack.commitSha.slice(0, 7);
      await writeTruthFile(deps.stateDir, "evidence", truthName(`${task.id.replace(/[^A-Za-z0-9-]/g, "_")}-${sha.replace(/[^0-9a-f]/g, "_")}-edit.json`), JSON.stringify({ schema: 1, taskId: task.id, sha, at: new Date().toISOString(), section: current.slice(0, 60_000) }));
      edited = { sha, bytes: Math.min(current.length, 60_000) };
    }
  }
  const done = await deps.publish({ github: deps.github, slug, number, taskId: task.id, pack, localDir: deps.localDir(task.id, pack.commitSha), repoPath: task.repoPath, approved });
  // With no token behind the port nothing was published: no cursor, no ready.
  if (done.comment === "skipped") return { published: false, reason: "GitHub is not reachable with a token", pack };
  await deps.save(task.id, done.pack);
  if (deps.stateDir) {
    const cursor = (await loadCursor(deps.stateDir, task.id)) ?? emptyCursor({ slug, number });
    const section = sectionOf((await deps.github.prFacts(slug, number).catch(() => null))?.body ?? "");
    const { validity, ...rest } = cursor;
    await saveCursor(deps.stateDir, task.id, { ...rest, pr: { slug, number }, published: { sha: pack.commitSha }, ...(section !== null ? { publishedSection: sha256(section) } : {}) });
    // The browser run was repeated after a fix: did a scenario's result change? Taught once, then forgotten.
    if (validity && deps.truth) {
      const derived = e2eCompareTruth(validity.before, Object.fromEntries(done.pack.scenarios.map((s, i) => [`s${i + 1}`, s.result])));
      if (derived) await deps.truth.learned({ pack: "evidence_valid", recordId: validity.recordId, label: derived.label, kind: derived.kind, source: derived.source, taskId: task.id }).catch(() => {});
    }
  }
  if (draft) await deps.github.markPrReady(slug, number);
  return { published: true, pack: done.pack, comment: done.comment, assets: done.assets, readied: draft, notes: done.notes ?? [], ...(edited ? { edited } : {}) };
}
