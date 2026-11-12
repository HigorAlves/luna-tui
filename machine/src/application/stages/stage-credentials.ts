// The credentials a stage container gets: its engine's, and each credential its pack's helpers on
// another engine need, since `delegate` runs them inside the same container (RFC 0002, phase 7):
// verifying's second opinion on codex:sol takes the Codex login, its lease included, beside the
// Claude token. Each credential once. The stage's own is required as before; a helper's that is
// missing, held back (a disabled runtime, a monthly cap) or busy past a short wait is left out
// with a note, and the helper's call then fails inside the stage while the agent goes on.
import { type EngineId, type Pack, credentialOwner, helpersOn, resolveEngine } from "@hardness/contracts";

import { CredentialWaitError, type Credentials, NoCredentialError, type PrepareWait, type RunCredential } from "../../adapters/credentials/index.ts";

/** How long a stage waits for a helper's credential another run holds before it runs without it. */
export const HELPER_CREDENTIAL_WAIT_MS = 2 * 60_000;

export interface StageCredentialOptions extends PrepareWait {
  /** The repo the run is for, for the machine's per-repo holds. */
  repo?: string | null;
  /** A line for the task's activity: a helper's credential left out, and why. */
  note?: (line: string) => void;
}

/** The engine's credential and its pack's helpers', merged into one; `release` gives each back.
 *  Rejects as `credentials.prepare` does for the stage's own engine. */
export async function prepareStageCredentials(credentials: Credentials, pack: Pack, engine: EngineId, runDir: string, options: StageCredentialOptions = {}): Promise<RunCredential> {
  const { repo, note, ...wait } = options;
  const prepared = [await credentials.prepare(engine, runDir, wait)];
  const owners = new Set([credentialOwner(engine)]);
  const helpers = helpersOn(pack, resolveEngine(engine).runtime);
  try {
    for (const helper of helpers) {
      const owner = credentialOwner(helper.engine);
      if (owners.has(owner)) continue;
      owners.add(owner);
      const skip = (why: string) => note?.(`${pack.id}'s ${helper.role} on ${helper.engine} is not available in this run: ${why}`);
      const availability = await credentials.check(helper.engine, { repo });
      if (!availability.available) {
        skip(availability.reason);
        continue;
      }
      try {
        const timeoutMs = Math.min(wait.timeoutMs ?? HELPER_CREDENTIAL_WAIT_MS, HELPER_CREDENTIAL_WAIT_MS);
        prepared.push(await credentials.prepare(helper.engine, runDir, { ...wait, timeoutMs }));
      } catch (error) {
        if (!(error instanceof NoCredentialError || error instanceof CredentialWaitError)) throw error;
        skip(error.message);
      }
    }
  } catch (error) {
    await Promise.all(prepared.map((c) => c.release()));
    throw error;
  }
  return {
    env: Object.assign({}, ...prepared.map((c) => c.env)),
    mounts: prepared.flatMap((c) => c.mounts),
    release: () => Promise.all(prepared.map((c) => c.release())).then(() => {}),
  };
}
