// The port for a repository's scoped secrets: values the OWNER put in their own store for one repository. A luna.yaml names a secret; it
// never holds one, and the machine's own environment is never a source (a repository could otherwise name a variable the machine holds).
export interface MissingSecret {
  name: string;
  /** Why it counts as missing; never holds a value. */
  reason: string;
}

export interface SecretStore {
  /** The folder the owner puts a repository's secrets in, for the message a missing one produces. */
  folder(repoPath: string): string;
  load(repoPath: string, names: readonly string[]): Promise<{ values: Record<string, string>; missing: MissingSecret[] }>;
}

/** A store with nothing in it: every name is missing. */
export function noSecrets(): SecretStore {
  return {
    folder: () => "(no secrets store is configured)",
    load: async (_repo, names) => ({ values: {}, missing: names.map((name) => ({ name, reason: "no secrets store is configured" })) }),
  };
}
