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

export interface Proof {
  proof: ProofReport[];
  /** The whole run, for the transcript. */
  log: string;
  /** Hosts a check tried to reach that no list names (`host:port`), first seen first: what `sandbox.egress.allow` may need. */
  refused: string[];
}

const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

export async function proveConfig(
  config: LunaConfig,
  options: { exec: ProofExec; repoPath: string; signal: AbortSignal; env?: NodeJS.ProcessEnv; stage: string; timeoutMs?: number },
): Promise<Proof> {
  const proof: ProofReport[] = [];
  const log: string[] = [];
  const refused: string[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? PROOF_TIMEOUT_MS);
  const allow = config.sandbox?.egress?.allow ?? [];
  for (const check of config.checks ?? []) {
    const { name, cmd, argv } = checkCommand(check);
    const remaining = deadline - Date.now();
    const result =
      remaining <= 0
        ? { code: 1, stdout: "", stderr: `skipped: the ${Math.round((options.timeoutMs ?? PROOF_TIMEOUT_MS) / MINUTE)} minute proof budget ran out` }
        : await options.exec(argv[0]!, argv.slice(1), {
            cwd: options.repoPath,
            signal: options.signal,
            timeoutMs: remaining,
            env: { ...process.env, ...options.env, HARDNESS_STAGE: options.stage },
            services: config.services ?? {},
            repoPath: options.repoPath,
            ...(allow.length ? { egressAllow: allow } : {}),
          });
    if (options.signal.aborted) break;
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
    log.push(`$ ${cmd}\n(exit ${result.code})\n${output}\n`);
    proof.push({ name, cmd, ok: result.code === 0, tail: tailOf(output) });
    for (const row of ("blocked" in result ? result.blocked : undefined) ?? []) {
      // Only a name no list holds is the file's to add; an address or a private one is never allowed by name.
      if (row.reason !== "not_listed") continue;
      const at = `${row.host}:${row.port}`;
      if (!refused.includes(at) && refused.length < REFUSED_MAX) refused.push(at);
    }
  }
  return { proof, log: log.join("\n") || "no checks proposed\n", refused };
}

/** The refused hosts as the names `sandbox.egress.allow` takes: a 443 is the default and left off, any other port kept. */
export function allowEntriesOf(refused: readonly string[]): string[] {
  return [...new Set(refused.map((at) => (at.endsWith(":443") ? at.slice(0, -4) : at)))];
}
