// The proof of a luna.yaml: every check it names, run once as a check container would run it, with its services beside it and its own
// egress list on top of the machine's. The setup stage proves the setup pack's proposal with it; `POST /repos/config/prove` proves the file a
// person (or the setup skill) wrote. What the egress proxy refused is collected by host, so the file can name the hosts a check needs.
import type { ExecResult } from "../adapters/process/exec.ts";
import { checkCommand } from "../domain/checks.ts";
import type { LunaConfig } from "../domain/luna-config.ts";
import type { ServiceSpec } from "@hardness/contracts";

const MINUTE = 60_000;
/** The whole proof shares verifying's budget. */
export const PROOF_TIMEOUT_MS = 30 * MINUTE;
const TAIL_LINES = 60;
const REFUSED_MAX = 30;

export interface ProofReport {
  name: string;
  cmd: string;
  ok: boolean;
  tail: string;
}

export type ProofExec = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec>; repoPath?: string; egressAllow?: readonly string[] },
) => Promise<ExecResult & { blocked?: Array<{ host: string; port: number; reason: string }> }>;

/** The app start (`verify.e2e.start`) proven: the app started from the file's command in its own container, with the file's services and
 *  egress list, and answered its ready path, exactly as the browser run starts it; then it was stopped. */
export interface AppProof {
  ok: boolean;
  /** How long it took to answer, or to fail. */
  seconds: number;
  /** Why it did not answer (it exited, it timed out, the seed failed, a secret is missing), when it did not. */
  reason?: string;
  /** The app's last log lines, flattened, when it did not answer. */
  logTail?: string;
  /** What its proxy refused, as `host:port`. */
  refused: string[];
}

/** Where a proof runs: never in the person's own checkout, which a check's install would fill with another platform's binaries. */
export interface ProofRig {
  /** A throwaway clone of the repository, made as a card's workspace is, and removed by `close`. */
  workspace(repoPath: string): Promise<{ path: string; close(): Promise<void> }>;
  /** Starts the app the file names in that clone and stops it once it answered. */
  app(input: { repoPath: string; workspace: string; config: LunaConfig; signal: AbortSignal }): Promise<AppProof>;
}

export interface Proof {
  proof: ProofReport[];
  /** The app start, when the file names one and the proof had a rig to start it with; null when there is nothing to start. */
  app: AppProof | null;
  /** The whole run, for the transcript. */
  log: string;
  /** Hosts a check or the app tried to reach that no list names (`host:port`), first seen first: what `sandbox.egress.allow` may need. */
  refused: string[];
}

const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** Proves `config` against `repoPath`: in a throwaway clone when a rig is given (always, outside tests), every check once, then the app start. */
export async function proveConfig(
  config: LunaConfig,
  options: { exec: ProofExec; repoPath: string; signal: AbortSignal; env?: NodeJS.ProcessEnv; stage: string; timeoutMs?: number; rig?: ProofRig },
): Promise<Proof> {
  const proof: ProofReport[] = [];
  const log: string[] = [];
  const refused: string[] = [];
  const budget = options.timeoutMs ?? PROOF_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const allow = config.sandbox?.egress?.allow ?? [];
  const note = (host: string, port: number) => {
    const at = `${host}:${port}`;
    if (!refused.includes(at) && refused.length < REFUSED_MAX) refused.push(at);
  };
  const space = options.rig ? await options.rig.workspace(options.repoPath) : null;
  const cwd = space?.path ?? options.repoPath;
  let app: AppProof | null = null;
  try {
    for (const check of config.checks ?? []) {
      const { name, cmd, argv } = checkCommand(check);
      const remaining = deadline - Date.now();
      let result: Awaited<ReturnType<ProofExec>>;
      try {
        result =
          remaining <= 0
            ? { code: 1, stdout: "", stderr: `skipped: the ${Math.round(budget / MINUTE)} minute proof budget ran out` }
            : await options.exec(argv[0]!, argv.slice(1), {
                cwd,
                signal: options.signal,
                timeoutMs: remaining,
                env: { ...process.env, ...options.env, HARDNESS_STAGE: options.stage },
                services: config.services ?? {},
                repoPath: options.repoPath,
                ...(allow.length ? { egressAllow: allow } : {}),
              });
      } catch (error) {
        // The install before a check (or a missing secret) is the check's failure, not the proof's: the rest still runs.
        result = { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      if (options.signal.aborted) break;
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      log.push(`$ ${cmd}\n(exit ${result.code})\n${output}\n`);
      proof.push({ name, cmd, ok: result.code === 0, tail: tailOf(output) });
      // Only a name no list holds is the file's to add; an address or a private one is never allowed by name.
      for (const row of ("blocked" in result ? result.blocked : undefined) ?? []) if (row.reason === "not_listed") note(row.host, row.port);
    }
    if (space && options.rig && config.verify?.e2e?.start?.command && !options.signal.aborted) {
      app = await options.rig.app({ repoPath: options.repoPath, workspace: space.path, config, signal: options.signal }).catch((error: unknown) => ({ ok: false, seconds: 0, reason: error instanceof Error ? error.message : String(error), refused: [] }));
      log.push(`$ app start: ${config.verify.e2e.start.command}\n(${app.ok ? `answered in ${app.seconds} s` : `did not answer: ${app.reason ?? "unknown"}`})\n${app.logTail ?? ""}\n`);
      for (const at of app.refused) {
        const colon = at.lastIndexOf(":");
        note(at.slice(0, colon), Number(at.slice(colon + 1)));
      }
    }
  } finally {
    await space?.close().catch(() => {});
  }
  return { proof, app, log: log.join("\n") || "no checks proposed\n", refused };
}

/** The refused hosts as the names `sandbox.egress.allow` takes: a 443 is the default and left off, any other port kept. */
export function allowEntriesOf(refused: readonly string[]): string[] {
  return [...new Set(refused.map((at) => (at.endsWith(":443") ? at.slice(0, -4) : at)))];
}
