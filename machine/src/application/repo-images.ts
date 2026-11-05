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

export type RepoImageEvent =
  | { kind: "image_refused"; repoPath: string; reason: string }
  | { kind: "image_built"; repoPath: string; image: string; base: string }
  | { kind: "image_build_failed"; repoPath: string; base: string; reason: string };

export interface RepoImagesDeps {
  machineImage: string;
  /** The repository's `sandbox.image`, from its own luna.yaml as the machine already reads policy. */
  imageOf: (repoPath: string) => Promise<{ base?: string | null } | undefined>;
  slugOf: (repoPath: string) => string;
  /** What names a repository's work folders' parent (the checks runner knows only the folder); defaults to the slug. */
  workKeyOf?: (repoPath: string) => string;
  docker: ImageDocker;
  /** How long a repository's resolved image is trusted before its base is looked at again (a floating tag moves). Default ten minutes. */
  ttlMs?: number;
  now?: () => number;
  onEvent?: (event: RepoImageEvent) => void;
}

export interface RepoImages {
  /** The image the repository's stages run in, built first when it names a base and has none yet. */
  ensure(repoPath: string, signal?: AbortSignal): Promise<{ image: string }>;
  /** The image last ensured for the repository whose work folders sit under this key; null when unknown or ambiguous. */
  knownFor(workKey: string): string | null;
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
  const known = new Map<string, string | null>();
  const resolved = new Map<string, { base: string; image: string; at: number }>();
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 10 * 60_000;
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };
  const remember = (repoPath: string, image: string) => {
    const key = (deps.workKeyOf ?? deps.slugOf)(repoPath);
    known.set(key, known.has(key) && known.get(key) !== image ? null : image);
  };
  const emit = (event: RepoImageEvent) => deps.onEvent?.(event);

  return {
    knownFor: (workKey) => known.get(workKey) ?? null,
    async ensure(repoPath, signal) {
      const spec = imageSpecOf(await deps.imageOf(repoPath));
      if (spec.kind === "machine") return { image: deps.machineImage };
      if (spec.kind === "refused") {
        emit({ kind: "image_refused", repoPath, reason: safe(spec.reason) });
        return { image: deps.machineImage };
      }
      const fresh = resolved.get(repoPath);
      if (fresh && fresh.base === spec.base && now() - fresh.at < ttl) return { image: fresh.image };
      return oneAtATime(async () => {
        const checked = await deps.docker.checkBase(spec.base);
        if (!checked.ok) {
          emit({ kind: "image_refused", repoPath, reason: logTail(checked.reason) });
          return { image: deps.machineImage };
        }
        const layerKey = await deps.docker.layerKey(deps.machineImage);
        const tag = repoImageTag(deps.slugOf(repoPath), checked.digest, layerKey);
        if (!(await deps.docker.exists(tag))) {
          const built = await deps.docker.build({ tag, base: spec.base, baseDigest: checked.digest, machineImage: deps.machineImage, layerKey, signal });
          if (!built.ok) {
            const reason = logTail(built.log);
            emit({ kind: "image_build_failed", repoPath, base: safe(spec.base), reason });
            throw new RepoImageError(reason);
          }
          emit({ kind: "image_built", repoPath, image: tag, base: safe(spec.base) });
        }
        remember(repoPath, tag);
        resolved.set(repoPath, { base: spec.base, image: tag, at: now() });
        return { image: tag };
      });
    },
  };
}
