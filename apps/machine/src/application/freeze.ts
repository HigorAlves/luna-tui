// Where the machine learns when nothing may merge. The monitor reads freeze windows only through this port;
// luna.yaml's `freeze[]` is the first adapter (`adapters/freeze/luna-yaml.ts`), a calendar service could be the next.
import type { Freeze } from "../domain/policy.ts";

export interface FreezeSource {
  /** The windows that apply to a repository (the user's checkout). A rejection is read by the caller as frozen. */
  windows(repoPath: string | null): Promise<Freeze[]>;
}

/** No calendar: nothing is frozen. */
export const noFreezeSource = (): FreezeSource => ({ windows: async () => [] });
