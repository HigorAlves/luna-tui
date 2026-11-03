// What every runtime's credential loader gives a stage: environment variables and mounts, and a
// release once the container is gone. A value only ever travels in the docker process's
// environment or a file under the run's own folder; it is never logged, nor answered by `check`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A host path mounted into the stage container. */
export interface CredentialMount {
  host: string;
  container: string;
  readOnly: boolean;
}

/** What one run gets. */
export interface RunCredential {
  /** Passed to the container by name; the values ride in docker's own environment. */
  env: Record<string, string>;
  mounts: CredentialMount[];
  /** Called once the container is gone, whatever its outcome. */
  release(): Promise<void>;
}

export type Availability = { available: true } | { available: false; reason: string };

export interface CredentialLoader {
  /** Whether this machine has the credential, and if not, what is missing. Never the value. */
  check(): Promise<Availability>;
  /** The credential one run gets, prepared under its run folder. Rejects with `NoCredentialError` when missing. */
  prepare(runDir: string): Promise<RunCredential>;
}

export interface CredentialOptions {
  /** Defaults to the machine's own environment. */
  env?: NodeJS.ProcessEnv;
  /** Where `~/.config/hardness` and `~/.codex` are; defaults to the machine user's home. */
  home?: string;
  /** One line per notable event (a refreshed token written back, or not); defaults to console.log. */
  log?: (line: string) => void;
}

export class NoCredentialError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NoCredentialError";
  }
}

/** The loader with nothing behind it: `check` says why, `prepare` refuses with the same reason. */
export function noCredential(reason: string): CredentialLoader {
  return {
    check: () => Promise.resolve({ available: false, reason }),
    prepare: () => Promise.reject(new NoCredentialError(reason)),
  };
}

/** `~/.config/hardness` under `home`: the machine's own secrets folder. */
export const secretsDir = (home: string): string => join(home, ".config", "hardness");

/** A secret file's content with whitespace removed (tokens never hold any; a copy from a terminal can wrap them), or null. */
export async function secretFile(dir: string, file: string): Promise<string | null> {
  try {
    const value = (await readFile(join(dir, file), "utf8")).replace(/\s+/g, "");
    return value || null;
  } catch {
    return null;
  }
}

/** An API key from an environment variable, else a file in the secrets folder; it reaches the container as that variable. */
export function apiKeyCredentials(key: { name: string; file: string; what: string }, opts: { env: NodeJS.ProcessEnv; home: string }): CredentialLoader {
  const load = async (): Promise<string | null> => opts.env[key.name] || (await secretFile(secretsDir(opts.home), key.file));
  const missing = `no ${key.what}: set ${key.name} or put it in ~/.config/hardness/${key.file}`;
  return {
    async check() {
      return (await load()) ? { available: true } : { available: false, reason: missing };
    },
    async prepare() {
      const value = await load();
      if (!value) throw new NoCredentialError(missing);
      return { env: { [key.name]: value }, mounts: [], release: async () => {} };
    },
  };
}
