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
  checkBase(base: string, signal?: AbortSignal): Promise<{ ok: true; digest: string } | { ok: false; reason: string }>;
  exists(tag: string): Promise<boolean>;
  build(spec: ImageBuildSpec): Promise<{ ok: true } | { ok: false; log: string }>;
}

/** What happened to a repository's image, for the card that needed it (`taskId`): a row on its stream. Text is flattened and capped. */
export type RepoImageEvent = { taskId?: string; repoPath: string } & (
  | { kind: "image.build_started"; base: string }
  | { kind: "image.built"; image: string; base: string }
  | { kind: "image.refused"; base?: string; reason: string }
  /** A base the repository names that no person approved for it: not pulled, not built (a machine-only kind: a stage's own events are stored under `stage.`). */
  | { kind: "image.base_pending"; base: string }
  | { kind: "image.build_failed"; base: string; reason: string }
);

export interface RepoImagesDeps {
  machineImage: string;
  /** The repository's `sandbox.image`, from its own luna.yaml as the machine already reads policy. */
  imageOf: (repoPath: string) => Promise<{ base?: string | null } | undefined>;
  slugOf: (repoPath: string) => string;
  docker: ImageDocker;
  /** The bases a person approved, per repository and exact reference; a base without it is neither pulled nor built. */
  approvals: { isApproved(repoPath: string, base: string): Promise<boolean> };
  /** How long a repository's resolved image is trusted before its base is looked at again (a floating tag moves). Default ten minutes. */
  ttlMs?: number;
  now?: () => number;
  onEvent?: (event: RepoImageEvent) => void;
}

export interface RepoImages {
  /** The image the repository's stages run in, built first when it names a base and has none yet. */
  ensure(repoPath: string, signal?: AbortSignal, taskId?: string): Promise<{ image: string }>;
  /** The reference the repository names that is waiting for a person; null when it names none, or its base is approved. */
  pending(repoPath: string): Promise<string | null>;
  /** A person approved the base the repository names now: what was remembered of its refusals and failures is forgotten. */
  approved(repoPath: string): void;
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
  /** A refusal or a failure of one base for one repository, remembered for a while so every stage, check and graph build does not pull again. */
  const memory = new Map<string, { at: number; refusal: string } | { at: number; failure: string }>();
  const waiting = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 10 * 60_000;
  const statuses = new Map<string, { image: string; builtAt: string | null; lastFailure: string | null }>();
  const emit = (event: RepoImageEvent) => deps.onEvent?.(event);
  const keyOf = (repoPath: string, base: string) => `${repoPath}\0${base}`;
  /** One queue per base: a slow registry holds up the repositories that name it, not the others. */
  const queued = <T>(base: string, job: () => Promise<T>): Promise<T> => {
    const run = (queues.get(base) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    queues.set(base, tail);
    void tail.then(() => queues.get(base) === tail && queues.delete(base));
    return run;
  };
  /** The caller stops waiting when it is aborted; the job itself carries on for whoever else asked. */
  const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("stopped while waiting for the repository's image"), { name: "AbortError" }));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  return {
    status: (repoPath) => statuses.get(repoPath) ?? null,
    approved(repoPath) {
      for (const key of [...memory.keys()]) if (key.startsWith(`${repoPath}\0`)) memory.delete(key);
      resolved.delete(repoPath);
    },
    async pending(repoPath) {
      const spec = imageSpecOf(await deps.imageOf(repoPath));
      return spec.kind === "repo" && !(await deps.approvals.isApproved(repoPath, spec.base)) ? spec.base : null;
    },
    async ensure(repoPath, signal, taskId) {
      const at = { repoPath, ...(taskId ? { taskId } : {}) };
      const spec = imageSpecOf(await deps.imageOf(repoPath));
      if (spec.kind === "machine") return { image: deps.machineImage };
      if (spec.kind === "refused") {
        emit({ ...at, kind: "image.refused", reason: safe(spec.reason) });
        return { image: deps.machineImage };
      }
      // Nothing of the base is touched, not even a pull, until a person approved this exact reference for this repository.
      if (!(await deps.approvals.isApproved(repoPath, spec.base))) {
        const key = keyOf(repoPath, spec.base);
        if (!waiting.has(key)) {
          waiting.add(key);
          emit({ ...at, kind: "image.base_pending", base: safe(spec.base) });
        }
        return { image: deps.machineImage };
      }
      const fresh = resolved.get(repoPath);
      if (fresh && fresh.base === spec.base && now() - fresh.at < ttl) return { image: fresh.image };
      const key = keyOf(repoPath, spec.base);
      const remembered = memory.get(key);
      if (remembered && now() - remembered.at < ttl) {
        if ("failure" in remembered) throw new RepoImageError(remembered.failure);
        return { image: deps.machineImage };
      }
      return abortable(
        queued(spec.base, async () => {
          const checked = await deps.docker.checkBase(spec.base, signal);
          if (!checked.ok) {
            const reason = logTail(checked.reason);
            memory.set(key, { at: now(), refusal: reason });
            emit({ ...at, kind: "image.refused", base: safe(spec.base), reason });
            return { image: deps.machineImage };
          }
          const layerKey = await deps.docker.layerKey(deps.machineImage);
          const tag = repoImageTag(deps.slugOf(repoPath), checked.digest, layerKey);
          if (!(await deps.docker.exists(tag))) {
            emit({ ...at, kind: "image.build_started", base: safe(spec.base) });
            const built = await deps.docker.build({ tag, base: spec.base, baseDigest: checked.digest, machineImage: deps.machineImage, layerKey, signal });
            if (!built.ok) {
              const reason = logTail(built.log);
              memory.set(key, { at: now(), failure: reason });
              emit({ ...at, kind: "image.build_failed", base: safe(spec.base), reason });
              statuses.set(repoPath, { image: statuses.get(repoPath)?.image ?? tag, builtAt: statuses.get(repoPath)?.builtAt ?? null, lastFailure: reason });
              throw new RepoImageError(reason);
            }
            emit({ ...at, kind: "image.built", image: tag, base: safe(spec.base) });
            statuses.set(repoPath, { image: tag, builtAt: new Date(now()).toISOString(), lastFailure: null });
          }
          memory.delete(key);
          resolved.set(repoPath, { base: spec.base, image: tag, at: now() });
          if (!statuses.get(repoPath) || statuses.get(repoPath)!.image !== tag) statuses.set(repoPath, { image: tag, builtAt: null, lastFailure: null });
          return { image: tag };
        }),
        signal,
      );
    },
  };
}
