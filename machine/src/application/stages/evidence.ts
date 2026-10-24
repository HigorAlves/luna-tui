// The evidence stage runs on the host: orc's evidence pack is script-only, so there is
// nothing to put in a container. It reads what the latest e2e run left under
// `<stateDir>/runs/<runId>/files/qa/`, checks the QA manifest and lists the files, which
// then show up in the ship approval's `requested`.
import type { ArtifactKind } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import type { StageResult, StageRunner } from "../ports.ts";

export interface EvidenceDeps {
  stateDir: string;
  /** The task's latest e2e run and the detail it finished with. */
  latestE2e: (taskId: string) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
}

const MANIFEST = "qa-manifest.json";
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEOS = new Set([".webm", ".mp4", ".mov"]);
const THUMBNAILS = 3;

const kindOf = (name: string): ArtifactKind => {
  const ext = extname(name).toLowerCase();
  if (name === MANIFEST) return "qa-manifest";
  if (IMAGES.has(ext)) return "screenshot";
  if (VIDEOS.has(ext)) return "video";
  if (ext === ".har") return "har";
  return "report";
};

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

export function evidenceRunner(deps: EvidenceDeps): StageRunner {
  return async (context) => {
    const e2e = await deps.latestE2e(context.task.id);
    const qaDir = e2e ? join(deps.stateDir, "runs", e2e.runId, "files", "qa") : undefined;
    const manifestPath = qaDir ? join(qaDir, MANIFEST) : undefined;

    let verdict: string | undefined;
    if (manifestPath) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { verdict?: unknown };
        verdict = typeof manifest.verdict === "string" ? manifest.verdict : "unreadable";
      } catch (error) {
        verdict = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : "unreadable";
      }
    }

    if (verdict === undefined) {
      if (e2e?.detail?.skipped === true) {
        const why = e2e.detail.reason ?? e2e.detail.note;
        return {
          outcome: "pass",
          detail: {
            step: "evidence",
            verdict: "skipped",
            artifactCount: 0,
            thumbnails: [],
            note: `e2e skipped${why ? `: ${String(why)}` : ""}`,
            evidence: { verdict: "skipped", artifactCount: 0, manifest: null, thumbnails: [] },
          },
        };
      }
      return {
        outcome: "fail",
        detail: {
          step: "evidence",
          verdict: "missing",
          artifactCount: 0,
          error: `no ${MANIFEST} from the e2e run; the criteria are not shown working`,
        },
      };
    }

    const files = await walk(qaDir!);
    const artifacts: NonNullable<StageResult["artifacts"]> = [];
    for (const path of files) {
      artifacts.push({
        kind: kindOf(path.slice(path.lastIndexOf("/") + 1)),
        path,
        label: relative(qaDir!, path),
        sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      });
    }
    const passed = verdict === "pass" || verdict === "skipped";
    const thumbnails = artifacts.filter((a) => a.kind === "screenshot").slice(0, THUMBNAILS).map((a) => a.path);
    return {
      outcome: passed ? "pass" : "fail",
      detail: {
        step: "evidence",
        verdict,
        artifactCount: artifacts.length,
        manifestPath,
        thumbnails,
        // The ship approval's `requested.evidence`, which the board shows.
        evidence: { verdict, artifactCount: artifacts.length, manifest: manifestPath, thumbnails },
      },
      artifacts,
    };
  };
}
