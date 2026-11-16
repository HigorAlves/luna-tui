// The image a repository's stages run in: the machine's own, or one built for the repository from the base its own
// luna.yaml names (`sandbox.image.base`) with the machine's layer on top. The base is checked first (a plain reference,
// Linux, glibc, the host's architecture); a base that fails is refused with the reason and the repository runs on the
// machine's image. A build that fails throws `RepoImageError`, whose reason is untrusted text, flattened and capped.
import { imageSpecOf, repoImageTag } from "../domain/image-spec.ts";
import { safe } from "../domain/evidence-markdown.ts";
import { isDockerfileKey } from "../domain/dockerfile-key.ts";
import type { RepoDockerfile } from "./repo-image-source.ts";

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
  checkBase(base: string, signal?: AbortSignal, toolchains?: Record<string, string>, options?: { local?: boolean }): Promise<{ ok: true; digest: string; toolchainWarnings?: string[] } | { ok: false; reason: string }>;
  exists(tag: string): Promise<boolean>;
  build(spec: ImageBuildSpec): Promise<{ ok: true } | { ok: false; log: string }>;
  /** Builds an approved Dockerfile of the repository on the default network (no secrets, no credentials); the log comes back either way. */
  buildDockerfile(spec: DockerfileBuildSpec): Promise<{ ok: true; log: string } | { ok: false; log: string }>;
}

export interface DockerfileBuildSpec {
  tag: string;
  /** The approved key: kept as a label on the image. */
  key: string;
  /** The approved bytes; a build runs these, not what the checkout holds by then. */
  text: string;
  /** A real folder inside the user's checkout. */
  context: string;
  args: Record<string, string>;
  signal?: AbortSignal;
}

/** What happened to a repository's image, for the card that needed it (`taskId`): a row on its stream. Text is flattened and capped. */
export type RepoImageEvent = { taskId?: string; repoPath: string } & (
  | { kind: "image.build_started"; base: string }
  | { kind: "image.built"; image: string; base: string }
  | { kind: "image.refused"; base?: string; reason: string }
  /** A base the repository names that no person approved for it: not pulled, not built (a machine-only kind: a stage's own events are stored under `stage.`). */
  | { kind: "image.base_pending"; base: string }
  | { kind: "image.build_failed"; base: string; reason: string }
  /** A Dockerfile the repository builds from that no person approved (this exact content): not built. */
  | { kind: "image.dockerfile_pending"; path: string; key: string }
  /** An approved Dockerfile was built, on the default network; `log` is the capped tail of the build. */
  | { kind: "image.dockerfile_built"; image: string; path: string; log: string }
);

export interface RepoImagesDeps {
  machineImage: string;
  /** The repository's `sandbox.image`, from its own luna.yaml as the machine already reads policy. */
  imageOf: (repoPath: string) => Promise<{ base?: string | null; dockerfile?: Pick<RepoDockerfile, "path" | "context" | "contextRel" | "args" | "text" | "key"> | null } | undefined>;
  /** The repository's `toolchains` from luna.yaml; the probe checks the image against them. */
  toolchainsOf?: (repoPath: string) => Promise<Record<string, string>>;
  slugOf: (repoPath: string) => string;
  docker: ImageDocker;
  /** The bases a person approved, per repository and exact reference; a base without it is neither pulled nor built. */
  approvals: { isApproved(repoPath: string, base: string): Promise<boolean>; /** Every reference and `dockerfile=` key approved for the repository. */ list?(repoPath: string): Promise<string[]> };
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
  /** The Dockerfile the repository builds from that waits for a person (`changed`: an earlier one was approved); null when it names none, or it is approved. */
  pendingDockerfile(repoPath: string): Promise<{ path: string; key: string; changed: boolean } | null>;
  /** A person approved the base the repository names now: what was remembered of its refusals and failures is forgotten. */
  approved(repoPath: string): void;
  /** What this machine knows of the repository's own image: its tag, when it was built here, the last failure; null when it has none. */
  /** What the last probe of the repository's base found wrong with its `toolchains`; empty when nothing, or not probed yet. Never blocks a run. */
  warnings(repoPath: string): string[];
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
  const warned = new Map<string, string[]>();
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
    warnings: (repoPath) => warned.get(repoPath) ?? [],
    approved(repoPath) {
      for (const key of [...memory.keys()]) if (key.startsWith(`${repoPath}\0`)) memory.delete(key);
      resolved.delete(repoPath);
    },
    async pending(repoPath) {
      const spec = imageSpecOf(await deps.imageOf(repoPath));
      return spec.kind === "repo" && !(await deps.approvals.isApproved(repoPath, spec.base)) ? spec.base : null;
    },
    async pendingDockerfile(repoPath) {
      const source = await deps.imageOf(repoPath);
      const df = imageSpecOf(source).kind === "machine" ? source?.dockerfile : null;
      if (!df || (await deps.approvals.isApproved(repoPath, df.key))) return null;
      const changed = ((await deps.approvals.list?.(repoPath)) ?? []).some(isDockerfileKey);
      return { path: df.path, key: df.key, changed };
    },
    async ensure(repoPath, signal, taskId) {
      const at = { repoPath, ...(taskId ? { taskId } : {}) };
      const source = await deps.imageOf(repoPath);
      const spec = imageSpecOf(source);
      // A named base wins over a Dockerfile.
      const df = spec.kind === "machine" ? (source?.dockerfile ?? null) : null;
      if (spec.kind === "machine" && !df) return { image: deps.machineImage };
      if (spec.kind === "refused") {
        emit({ ...at, kind: "image.refused", reason: safe(spec.reason) });
        return { image: deps.machineImage };
      }
      // What names the image: a base's reference, or the key of an approved Dockerfile.
      const name = df ? df.key : spec.kind === "repo" ? spec.base : "";
      const label = df ? `Dockerfile ${df.path}` : name;
      // Nothing of the base is touched, not even a pull, until a person approved this exact reference (or Dockerfile) for this repository.
      if (!(await deps.approvals.isApproved(repoPath, name))) {
        const key = keyOf(repoPath, name);
        if (!waiting.has(key)) {
          waiting.add(key);
          emit(df ? { ...at, kind: "image.dockerfile_pending", path: safe(df.path), key: name } : { ...at, kind: "image.base_pending", base: safe(name) });
        }
        return { image: deps.machineImage };
      }
      const fresh = resolved.get(repoPath);
      if (fresh && fresh.base === name && now() - fresh.at < ttl) return { image: fresh.image };
      const key = keyOf(repoPath, name);
      const remembered = memory.get(key);
      if (remembered && now() - remembered.at < ttl) {
        if ("failure" in remembered) throw new RepoImageError(remembered.failure);
        return { image: deps.machineImage };
      }
      return abortable(
        queued(name, async () => {
          const toolchains = (await deps.toolchainsOf?.(repoPath).catch(() => undefined)) ?? {};
          // A Dockerfile is built first (reused by its tag), then the built image is probed where it is, without a pull.
          let baseRef = name;
          if (df) {
            baseRef = `hardness-devcontainer-${deps.slugOf(repoPath)}:${df.key.slice("dockerfile=sha256:".length, "dockerfile=sha256:".length + 12)}`;
            if (!(await deps.docker.exists(baseRef))) {
              emit({ ...at, kind: "image.build_started", base: safe(label) });
              const out = await deps.docker.buildDockerfile({ tag: baseRef, key: df.key, text: df.text, context: df.context, args: df.args, signal });
              if (!out.ok) {
                const reason = logTail(out.log);
                memory.set(key, { at: now(), failure: reason });
                emit({ ...at, kind: "image.build_failed", base: safe(label), reason });
                statuses.set(repoPath, { image: statuses.get(repoPath)?.image ?? baseRef, builtAt: statuses.get(repoPath)?.builtAt ?? null, lastFailure: reason });
                throw new RepoImageError(reason);
              }
              emit({ ...at, kind: "image.dockerfile_built", image: baseRef, path: safe(df.path), log: logTail(out.log) });
            }
          }
          const checked = await deps.docker.checkBase(baseRef, signal, toolchains, df ? { local: true } : undefined);
          if (checked.ok) warned.set(repoPath, (checked.toolchainWarnings ?? []).map((line) => safe(line).slice(0, 400)));
          if (!checked.ok) {
            const reason = logTail(checked.reason);
            memory.set(key, { at: now(), refusal: reason });
            emit({ ...at, kind: "image.refused", base: safe(label), reason });
            return { image: deps.machineImage };
          }
          const layerKey = await deps.docker.layerKey(deps.machineImage);
          const tag = repoImageTag(deps.slugOf(repoPath), checked.digest, layerKey);
          if (!(await deps.docker.exists(tag))) {
            emit({ ...at, kind: "image.build_started", base: safe(label) });
            const built = await deps.docker.build({ tag, base: baseRef, baseDigest: checked.digest, machineImage: deps.machineImage, layerKey, signal });
            if (!built.ok) {
              const reason = logTail(built.log);
              memory.set(key, { at: now(), failure: reason });
              emit({ ...at, kind: "image.build_failed", base: safe(label), reason });
              statuses.set(repoPath, { image: statuses.get(repoPath)?.image ?? tag, builtAt: statuses.get(repoPath)?.builtAt ?? null, lastFailure: reason });
              throw new RepoImageError(reason);
            }
            emit({ ...at, kind: "image.built", image: tag, base: safe(label) });
            statuses.set(repoPath, { image: tag, builtAt: new Date(now()).toISOString(), lastFailure: null });
          }
          memory.delete(key);
          resolved.set(repoPath, { base: name, image: tag, at: now() });
          if (!statuses.get(repoPath) || statuses.get(repoPath)!.image !== tag) statuses.set(repoPath, { image: tag, builtAt: null, lastFailure: null });
          return { image: tag };
        }),
        signal,
      );
    },
  };
}
