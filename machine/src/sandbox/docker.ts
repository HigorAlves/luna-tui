// Runs one stage in a fresh container and deletes it afterwards. The worktree is mounted at
// /work (read-only for read-only stages), the stage input at /in, and results come back in /out.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Credential } from "./credentials.ts";
import { exec, execOrThrow } from "./exec.ts";

/** Label on every stage container, so leftovers can be found and removed. */
export const CONTAINER_LABEL = "dev.hardness.stage";

export interface SandboxRun {
  name: string;
  image: string;
  /** Folder for this run's input, output and transcript. */
  runDir: string;
  worktree: string;
  writable: boolean;
  /** The repo's git dir, mounted read-only at the same path so git works inside. */
  gitDir: string | null;
  input: Record<string, unknown>;
  timeoutMs: number;
  credential: Credential;
  labels: Record<string, string>;
  /** Extra container env, for tooling such as the sandbox smoke. Not used by the machine. */
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** Called once the container is running, e.g. to open a watch pane. */
  onStarted?: (container: string) => void;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  transcriptPath: string;
}

/** The `docker run` argument list for one stage. Pure: the credential is named, never valued. */
export function sandboxArgs(run: SandboxRun, inDir: string, outDir: string): string[] {
  const args = ["run", "-d", "--name", run.name, "--label", `${CONTAINER_LABEL}=1`];
  for (const [key, value] of Object.entries(run.labels)) args.push("--label", `${key}=${value}`);
  // The agent needs outbound network for the Anthropic API, so this isn't `--network none` —
  // but nothing it does needs write access outside its mounted worktree, /in, /out or /tmp.
  args.push("--read-only", "--tmpfs", "/tmp:rw,size=512m", "--security-opt", "no-new-privileges");
  args.push(
    // npm/yarn/pip caches, shell history and anything else that defaults to $HOME would
    // otherwise hit the now-read-only root filesystem — point HOME at the one writable,
    // throwaway place left: the tmpfs above.
    "-e", "HOME=/tmp",
    // Temp files and orc's state live on the same tmpfs (orc also self-detects a read-only cwd).
    "-e", "TMPDIR=/tmp",
    "-e", "ORC_STATE_DIR=/tmp/orc-state",
    // The credential is passed by name; its value is only in docker's environment.
    "-e", run.credential.name,
    // The worktree is owned by the host user, not the container's.
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    "-v", `${run.worktree}:/work${run.writable ? "" : ":ro"}`,
    "-v", `${inDir}:/in:ro`,
    "-v", `${outDir}:/out`,
  );
  if (run.gitDir) args.push("-v", `${run.gitDir}:${run.gitDir}:ro`);
  for (const [key, value] of Object.entries(run.extraEnv ?? {})) args.push("-e", `${key}=${value}`);
  args.push(run.image);

  return args;
}

export async function runSandbox(run: SandboxRun): Promise<SandboxResult> {
  const inDir = join(run.runDir, "in");
  const outDir = join(run.runDir, "out");
  await mkdir(inDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(inDir, "stage.json"), JSON.stringify(run.input, null, 2));

  const args = sandboxArgs(run, inDir, outDir);

  await execOrThrow("docker", args, {
    env: { ...process.env, [run.credential.name]: run.credential.value },
  });
  run.onStarted?.(run.name);

  let timedOut = false;
  let aborted = false;
  const kill = () => void exec("docker", ["kill", run.name]);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, run.timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  run.signal?.addEventListener("abort", onAbort, { once: true });
  if (run.signal?.aborted) onAbort();

  const waited = await exec("docker", ["wait", run.name]);
  clearTimeout(timer);
  run.signal?.removeEventListener("abort", onAbort);

  const transcriptPath = join(run.runDir, "transcript.log");
  const logs = await exec("docker", ["logs", run.name]);
  await writeFile(transcriptPath, logs.stdout + logs.stderr);
  await exec("docker", ["rm", "-f", run.name]);

  const exitCode = waited.code === 0 ? Number(waited.stdout.trim()) : null;
  return { exitCode, timedOut, aborted, transcriptPath };
}

/** Removes stage containers left behind by a machine that stopped mid-stage. */
export async function removeLeftoverContainers(): Promise<number> {
  const listed = await exec("docker", ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}=1`]);
  const ids = listed.stdout.split("\n").filter(Boolean);
  if (ids.length > 0) await exec("docker", ["rm", "-f", ...ids]);
  return ids.length;
}

export async function imageExists(image: string): Promise<boolean> {
  return (await exec("docker", ["image", "inspect", image])).code === 0;
}
