// Where a repository's base image comes from: its luna.yaml (`sandbox.image.base`), else its `.devcontainer/devcontainer.json` (or
// `.devcontainer.json`) read from the USER's checkout, never a card's folder (as egress-policy.ts reads luna.yaml). luna.yaml wins.
// The machine's policy bounds the source: `images.devcontainer: deny` turns the reader off, `images.repo_base: deny` refuses its image.
// The same answer feeds the image build, the approval gate, repo health and the container env of a repo's own commands.
import { join } from "node:path";
import type { MachinePolicy } from "@hardness/contracts";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { safe } from "../domain/evidence-markdown.ts";
import { devcontainerOf } from "../domain/devcontainer.ts";

export interface RepoImageSourceOf {
  /** The base the repository's stages are built from; null when it names none. */
  base: string | null;
  origin: "luna.yaml" | "devcontainer" | null;
  /** From `containerEnv`: for the repo's own commands (install, checks, app), never an agent stage. */
  containerEnv: Record<string, string>;
  /** "not applied: <why>" lines for repo health. */
  notes: string[];
  /** Why the machine's policy refused the devcontainer image. */
  bounds: string[];
}

export interface RepoImageSource {
  for(repoPath: string): Promise<RepoImageSourceOf>;
}

export interface RepoImageSourceDeps {
  policies: { for(repoPath: string): Promise<{ factory: { sandbox: { image: { base: string | null } } } }> };
  machinePolicy: Pick<MachinePolicy, "images">;
  /** The text of a file, or null when it is absent; the default reads a regular file of at most 256 KB and never follows a link. */
  read?: (path: string) => Promise<string | null>;
}

const FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"];
const MAX_BYTES = 256 * 1024;
const DOCKERFILE_NOTE = "devcontainer.json build.dockerfile: not applied: the machine cannot yet build a repository's Dockerfile behind its egress proxy; the machine's image runs";

const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readRegularFile(path, MAX_BYTES);
  } catch {
    return null;
  }
};

export function repoImageSource(deps: RepoImageSourceDeps): RepoImageSource {
  const read = deps.read ?? readFileOrNull;
  return {
    async for(repoPath) {
      const own = (await deps.policies.for(repoPath)).factory.sandbox.image.base;
      const none: RepoImageSourceOf = { base: own, origin: own ? "luna.yaml" : null, containerEnv: {}, notes: [], bounds: [] };
      if (deps.machinePolicy.images.devcontainer === "deny") return none;
      let text: string | null = null;
      for (const file of FILES) {
        text = await read(join(repoPath, file));
        if (text !== null) break;
      }
      if (text === null) return none;
      const parsed = devcontainerOf(text);
      if (!parsed.ok) return { ...none, notes: [`${safe(parsed.reason).slice(0, 300)}: not applied`] };
      const notes = [...parsed.notApplied, ...(parsed.dockerfile ? [DOCKERFILE_NOTE] : [])].map((line) => safe(line).slice(0, 400));
      const bounds: string[] = [];
      let base = own;
      let origin = none.origin;
      if (!own && parsed.image) {
        if (deps.machinePolicy.images.repo_base === "deny") {
          bounds.push(`devcontainer.json image "${safe(parsed.image).slice(0, 200)}" is refused by the machine's sandbox policy (images.repo_base: deny); the machine's image runs`);
        } else {
          base = parsed.image;
          origin = "devcontainer";
        }
      }
      return { base, origin, containerEnv: parsed.containerEnv, notes, bounds };
    },
  };
}
