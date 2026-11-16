// Where a repository's base image comes from: its luna.yaml (`sandbox.image.base`), else its `.devcontainer/devcontainer.json` (or
// `.devcontainer.json`) read from the USER's checkout, never a card's folder (as egress-policy.ts reads luna.yaml). luna.yaml wins.
// The machine's policy bounds the source: `images.devcontainer: deny` turns the reader off, `images.repo_base: deny` refuses its image.
// The same answer feeds the image build, the approval gate, repo health and the container env of a repo's own commands.
import { dirname, join, posix } from "node:path";
import type { MachinePolicy } from "@hardness/contracts";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import { type InsideRepo, insideRepo } from "../adapters/fs/inside-repo.ts";
import { safe } from "../domain/evidence-markdown.ts";
import { devcontainerOf } from "../domain/devcontainer.ts";
import { dockerfileKey } from "../domain/dockerfile-key.ts";

/** A Dockerfile the repository's devcontainer.json builds from: read from the checkout, with the key a person approves. */
export interface RepoDockerfile {
  /** Repo-relative path of the Dockerfile, for display. */
  path: string;
  /** The folder docker builds in: a real path inside the checkout, and its repo-relative form. */
  context: string;
  contextRel: string;
  args: Record<string, string>;
  /** The Dockerfile's text as read now (UTF-8): the bytes the key covers, and the bytes a build runs. */
  text: string;
  key: string;
}

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
  /** The Dockerfile the devcontainer builds, when no base names an image and the policy allows it; null otherwise. */
  dockerfile: RepoDockerfile | null;
}

export interface RepoImageSource {
  for(repoPath: string): Promise<RepoImageSourceOf>;
}

export interface RepoImageSourceDeps {
  policies: { for(repoPath: string): Promise<{ factory: { sandbox: { image: { base: string | null } } } }> };
  machinePolicy: Pick<MachinePolicy, "images">;
  /** The text of a file, or null when it is absent; the default reads a regular file of at most 256 KB and never follows a link. */
  read?: (path: string) => Promise<string | null>;
  /** Resolves a repo-relative path to a real one that stays inside the checkout; the default follows links and refuses any that leave. */
  inside?: (repoPath: string, rel: string) => Promise<InsideRepo>;
}

const FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"];
const MAX_BYTES = 256 * 1024;
const DOCKERFILE_NOT_APPLIED = "devcontainer.json build.dockerfile: not applied:";
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readRegularFile(path, MAX_BYTES);
  } catch {
    return null;
  }
};

export function repoImageSource(deps: RepoImageSourceDeps): RepoImageSource {
  const read = deps.read ?? readFileOrNull;
  const inside = deps.inside ?? insideRepo;
  /** The Dockerfile and its context, both resolved inside the checkout; the path and context are relative to devcontainer.json's folder. */
  const dockerfileOf = async (repoPath: string, dir: string, build: { dockerfile: string; context: string | null; args: Record<string, string> }): Promise<{ ok: true; dockerfile: RepoDockerfile } | { ok: false; reason: string }> => {
    const file = await inside(repoPath, posix.join(dir, build.dockerfile));
    if (!file.ok) return { ok: false, reason: `the Dockerfile ${file.reason}` };
    const context = await inside(repoPath, posix.join(dir, build.context ?? "."));
    if (!context.ok) return { ok: false, reason: `the build context ${context.reason}` };
    const text = await read(file.abs);
    if (text === null) return { ok: false, reason: `the Dockerfile ${file.rel} could not be read` };
    const args = Object.fromEntries(Object.entries(build.args).filter(([name]) => ARG_NAME.test(name)));
    return { ok: true, dockerfile: { path: file.rel, context: context.abs, contextRel: context.rel, args, text, key: dockerfileKey({ text, args, context: context.rel }) } };
  };
  return {
    async for(repoPath) {
      const own = (await deps.policies.for(repoPath)).factory.sandbox.image.base;
      const none: RepoImageSourceOf = { base: own, origin: own ? "luna.yaml" : null, containerEnv: {}, notes: [], bounds: [], dockerfile: null };
      if (deps.machinePolicy.images.devcontainer === "deny") return none;
      let text: string | null = null;
      let found = "";
      for (const file of FILES) {
        text = await read(join(repoPath, file));
        if (text !== null) {
          found = file;
          break;
        }
      }
      if (text === null) return none;
      const parsed = devcontainerOf(text);
      if (!parsed.ok) return { ...none, notes: [`${safe(parsed.reason).slice(0, 300)}: not applied`] };
      const extra: string[] = [];
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
      let dockerfile: RepoDockerfile | null = null;
      if (parsed.dockerfile) {
        if (base) extra.push(`${DOCKERFILE_NOT_APPLIED} ${origin === "luna.yaml" ? "luna.yaml sandbox.image.base" : "the devcontainer image"} wins`);
        else if (deps.machinePolicy.images.repo_base === "deny") {
          bounds.push("devcontainer.json build.dockerfile is refused by the machine's sandbox policy (images.repo_base: deny); the machine's image runs");
        } else {
          const built = await dockerfileOf(repoPath, dirname(found), parsed.dockerfile);
          if (built.ok) dockerfile = built.dockerfile;
          else extra.push(`${DOCKERFILE_NOT_APPLIED} ${built.reason}`);
        }
      }
      const notes = [...parsed.notApplied, ...extra].map((line) => safe(line).slice(0, 400));
      return { base, origin, containerEnv: parsed.containerEnv, notes, bounds, dockerfile };
    },
  };
}
