// One pass of checks shares one set of services. A check that starts the repository's Postgres, its network and its proxy for itself pays
// a database start and a readiness wait for every command, including the ones that never touch a database. An exec that can open a
// session (the docker one) starts them once; any other exec runs each check as before.
import type { ServiceSpec } from "@hardness/contracts";

import type { ChecksSession, SessionOptions } from "../../adapters/docker/docker.ts";

/** An exec that can also open a session. */
export type SessionExec<F> = F & { session?: (options: SessionOptions) => Promise<ChecksSession> };

/** The exec to run a pass of checks with, and what removes the services when the pass is over. No services, or no session on the exec: the exec itself, and nothing to remove. */
export async function openChecksSession<F>(exec: SessionExec<F>, options: { cwd: string; repoPath?: string; services?: Record<string, ServiceSpec> }): Promise<{ exec: F; close: () => Promise<void> }> {
  const services = options.services ?? {};
  if (!exec.session || Object.keys(services).length === 0) return { exec, close: async () => {} };
  const opened = await exec.session({ cwd: options.cwd, services, ...(options.repoPath ? { repoPath: options.repoPath } : {}) });
  return { exec: opened.exec as unknown as F, close: opened.close };
}
