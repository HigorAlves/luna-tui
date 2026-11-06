// The image a repository's stages run in: the machine's own, or one built for the repository from the base its own
// luna.yaml names (`sandbox.image.base`) with the machine's layer on top. The base is checked first (a plain reference,
// Linux, glibc, the host's architecture); a base that fails is refused with the reason and the repository runs on the
// machine's image. A build that fails throws `RepoImageError`, whose reason is untrusted text, flattened and capped.
import { imageSpecOf, repoImageTag } from "../domain/image-spec.ts";
import { safe } from "../domain/evidence-markdown.ts";

export interface ImageBuildSpec {
  tag: string;
  base: string;
  baseDigest: string;
  machineImage: string;
  layerKey: string;
  signal?: AbortSignal;
}

/** The docker side, behind a port: `adapters/docker/image-build.ts` is the real one. */
export interface ImageDocker {
  /** The key of the machine's layer: the label of the machine's image. */
  layerKey(machineImage: string): Promise<string>;
  /** Pulls the base and checks it: Linux, glibc, the host's architecture. */
  checkBase(base: string): Promise<{ ok: true; digest: string } | { ok: false; reason: string }>;
  exists(tag: string): Promise<boolean>;
  build(spec: ImageBuildSpec): Promise<{ ok: true } | { ok: false; log: string }>;
}

/** What happened to a repository's image, for the card that needed it (`taskId`): a row on its stream. Text is flattened and capped. */
export type RepoImageEvent = { taskId?: string; repoPath: string } & (
  | { kind: "image.build_started"; base: string }
  | { kind: "image.built"; image: string; base: string }
  | { kind: "image.refused"; base?: string; reason: string }
  | { kind: "image.build_failed"; base: string; reason: string }
);

export interface RepoImagesDeps {
  machineImage: string;
  /** The repository's `sandbox.image`, from its own luna.yaml as the machine already reads policy. */
  imageOf: (repoPath: string) => Promise<{ base?: string | null } | undefined>;
  slugOf: (repoPath: string) => string;
  docker: ImageDocker;
  /** How long a repository's resolved image is trusted before its base is looked at again (a floating tag moves). Default ten minutes. */
  ttlMs?: number;
  now?: () => number;
  onEvent?: (event: RepoImageEvent) => void;
}

export interface RepoImages {
  /** The image the repository's stages run in, built first when it names a base and has none yet. */
  ensure(repoPath: string, signal?: AbortSignal, taskId?: string): Promise<{ image: string }>;
  /** What this machine knows of the repository's own image: its tag, when it was built here, the last failure; null when it has none. */
  status(repoPath: string): { image: string; builtAt: string | null; lastFailure: string | null } | null;
}

export class RepoImageError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RepoImageError";
  }
}

const REASON_CAP = 800;
const TAIL_LINES = 12;

/** The tail of a build log as one safe line: the reason is at the end, the rest is noise. */
export function logTail(log: string): string {
  const tail = log.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  const flat = safe(tail);
  return flat.length > REASON_CAP ? `...${flat.slice(-REASON_CAP)}` : flat;
}

export function repoImages(deps: RepoImagesDeps): RepoImages {
  const resolved = new Map<string, { base: string; image: string; at: number }>();
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 10 * 60_000;
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };
  const statuses = new Map<string, { image: string; builtAt: string | null; lastFailure: string | null }>();
  const emit = (event: RepoImageEvent) => deps.onEvent?.(event);

  return {
    status: (repoPath) => statuses.get(repoPath) ?? null,
    async ensure(repoPath, signal, taskId) {
      const at = { repoPath, ...(taskId ? { taskId } : {}) };
      const spec = imageSpecOf(await deps.imageOf(repoPath));
      if (spec.kind === "machine") return { image: deps.machineImage };
      if (spec.kind === "refused") {
        emit({ ...at, kind: "image.refused", reason: safe(spec.reason) });
        return { image: deps.machineImage };
      }
      const fresh = resolved.get(repoPath);
      if (fresh && fresh.base === spec.base && now() - fresh.at < ttl) return { image: fresh.image };
      return oneAtATime(async () => {
        const checked = await deps.docker.checkBase(spec.base);
        if (!checked.ok) {
          emit({ ...at, kind: "image.refused", base: safe(spec.base), reason: logTail(checked.reason) });
          return { image: deps.machineImage };
        }
        const layerKey = await deps.docker.layerKey(deps.machineImage);
        const tag = repoImageTag(deps.slugOf(repoPath), checked.digest, layerKey);
        if (!(await deps.docker.exists(tag))) {
          emit({ ...at, kind: "image.build_started", base: safe(spec.base) });
          const built = await deps.docker.build({ tag, base: spec.base, baseDigest: checked.digest, machineImage: deps.machineImage, layerKey, signal });
          if (!built.ok) {
            const reason = logTail(built.log);
            emit({ ...at, kind: "image.build_failed", base: safe(spec.base), reason });
            statuses.set(repoPath, { image: statuses.get(repoPath)?.image ?? tag, builtAt: statuses.get(repoPath)?.builtAt ?? null, lastFailure: reason });
            throw new RepoImageError(reason);
          }
          emit({ ...at, kind: "image.built", image: tag, base: safe(spec.base) });
          statuses.set(repoPath, { image: tag, builtAt: new Date(now()).toISOString(), lastFailure: null });
        }
        resolved.set(repoPath, { base: spec.base, image: tag, at: now() });
        if (!statuses.get(repoPath) || statuses.get(repoPath)!.image !== tag) statuses.set(repoPath, { image: tag, builtAt: null, lastFailure: null });
        return { image: tag };
      });
    },
  };
}
