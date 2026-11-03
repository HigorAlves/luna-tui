// The Codex (ChatGPT) login for `codex:*` engines. The Codex CLI owns `~/.codex/auth.json` and
// rewrites it when it refreshes the token, so each run gets its own copy: `<runDir>/codex/auth.json`
// (0600, in a 0700 folder), mounted writable at /tmp/.codex with CODEX_HOME pointing there. Once
// the container is gone, a copy the run refreshed goes back to the host, atomically, but only
// while the host file still holds what was copied; one changed meanwhile (you logged in again,
// another run wrote back first) is kept. The copy is deleted either way. See RFC 0002.
//
// A refresh rotates the refresh token, so two runs on one copied token would revoke each other:
// one Codex run at a time on this machine. A run takes the login's lease before it copies the
// file and gives it back after its write-back, so the next run copies the refreshed token.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type CredentialLoader, type CredentialOptions, CredentialWaitError, NoCredentialError, type PrepareWait, type RunCredential } from "./credential.ts";

/** Where the stage's Codex home is mounted: on the tmpfs, beside the HOME the container gets. */
export const CONTAINER_CODEX_HOME = "/tmp/.codex";
/** The run's copy lives in this folder under its run dir; the hash of what was copied sits beside it, outside the mount. */
const COPY_DIR = "codex";
const BASE_FILE = "codex-auth.sha256";
/** A Codex login is a few KB; a copy bigger than this is not one, whatever it parses as. */
const MAX_LOGIN_BYTES = 64 * 1024;
/** A write-back's temp file: `auth.json.<uuid>.tmp`, beside the host file. */
const TEMP_FILE = /^auth\.json\..+\.tmp$/;
const MINUTE = 60_000;

/** Where the Codex CLI keeps its login: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(opts: CredentialOptions = {}): string {
  return (opts.env ?? process.env).CODEX_HOME || join(opts.home ?? homedir(), ".codex");
}

const sha256 = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");

/** One holder at a time, the rest wait in turn. `take` resolves with the function that gives it back. */
export class CodexLease {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  async take(wait: PrepareWait = {}): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return this.giver();
    }
    wait.onWait?.("waiting for the Codex login: another Codex run on this machine is using it, and they run one at a time");
    const since = Date.now();
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const leave = () => {
        clearTimeout(timer);
        wait.signal?.removeEventListener("abort", onAbort);
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
      };
      const go = () => {
        leave();
        resolve();
      };
      const onAbort = () => {
        leave();
        reject(new CredentialWaitError("aborted while waiting for the Codex login"));
      };
      if (wait.signal?.aborted) return onAbort();
      wait.signal?.addEventListener("abort", onAbort, { once: true });
      if (wait.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          leave();
          const waited = Date.now() - since;
          const took = waited >= MINUTE ? `${Math.round(waited / MINUTE)} min` : `${Math.round(waited / 1000)} s`;
          reject(new CredentialWaitError(`waited ${took} for the Codex login, which another Codex run on this machine held past this stage's timeout`));
        }, wait.timeoutMs);
        timer.unref();
      }
      this.waiting.push(go);
    });
    return this.giver();
  }

  /** Gives the lease to the next in line, or frees it; only the first call counts. */
  private giver(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.held = false;
    };
  }
}

/** The machine's leases, one per login file: every loader for the same file shares it. */
const leases = new Map<string, CodexLease>();
function leaseFor(file: string): CodexLease {
  let lease = leases.get(file);
  if (!lease) {
    lease = new CodexLease();
    leases.set(file, lease);
  }
  return lease;
}

/** Write-backs run one at a time, so two runs that both refreshed cannot both pass the host-file check. */
let writeBacks: Promise<void> = Promise.resolve();
function oneAtATime(task: () => Promise<void>): Promise<void> {
  const next = writeBacks.then(task, task);
  writeBacks = next.catch(() => {});
  return next;
}

/** `lease` defaults to the machine's own for the login file; a test passes a fresh one to play another machine. */
export function codexCredentials(opts: CredentialOptions = {}, lease?: CodexLease): CredentialLoader {
  const file = join(codexHome(opts), "auth.json");
  const log = opts.log ?? ((line: string) => console.log(line));
  const missing = `no Codex login: ${file} is missing or unreadable (run \`codex login\`)`;
  const readable = () => access(file, constants.R_OK).then(() => true, () => false);
  return {
    async check() {
      return (await readable()) ? { available: true } : { available: false, reason: missing };
    },
    async prepare(runDir, wait): Promise<RunCredential> {
      // No login, nothing to wait for.
      if (!(await readable())) throw new NoCredentialError(missing);
      const give = await (lease ?? leaseFor(file)).take(wait);
      const dir = join(runDir, COPY_DIR);
      const copy = join(dir, "auth.json");
      const baseFile = join(runDir, BASE_FILE);
      let copiedFrom: string;
      try {
        // A re-attached run keeps the copy its container is using, and what it was copied from.
        let base = await readFile(baseFile, "utf8").then((text) => text.trim(), () => null);
        if (base === null || !(await readFile(copy).then(() => true, () => false))) {
          const login = await readFile(file).catch(() => null);
          if (!login) throw new NoCredentialError(missing);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await chmod(dir, 0o700);
          await writeFile(copy, login, { mode: 0o600 });
          await chmod(copy, 0o600);
          base = sha256(login);
          await writeFile(baseFile, base, { mode: 0o600 });
        }
        copiedFrom = base;
      } catch (error) {
        give();
        throw error;
      }
      const cleanUp = () => Promise.all([rm(dir, { recursive: true, force: true }), rm(baseFile, { force: true })]).then(() => {});
      return {
        env: { CODEX_HOME: CONTAINER_CODEX_HOME },
        mounts: [{ host: dir, container: CONTAINER_CODEX_HOME, readOnly: false }],
        // The lease passes on only after the write-back, so the next run copies what this one refreshed.
        // A write-back that fails is logged: the run's own result stands.
        release: () =>
          oneAtATime(() =>
            writeBack({ file, copy, copiedFrom, log })
              .catch((error: unknown) => log(`codex: could not write the refreshed login back to ${file}: ${error instanceof Error ? error.message : String(error)}`))
              .finally(cleanUp),
          ).finally(give),
      };
    },
  };
}

/** On machine start: the temp files a write-back left when the machine died mid-write. Answers how many went. */
export async function removeStaleCodexTemps(opts: CredentialOptions = {}): Promise<number> {
  const home = codexHome(opts);
  const names = await readdir(home).catch(() => [] as string[]);
  const stale = names.filter((name) => TEMP_FILE.test(name));
  await Promise.all(stale.map((name) => rm(join(home, name), { force: true })));
  return stale.length;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysOf = (value: Record<string, unknown>): string => Object.keys(value).sort().join("\n");

/** The compare-and-swap: the run's copy goes to `file` only when it changed, is a Codex login of the
 *  host file's shape (the same top-level keys, under 64 KB), and the host file is still `copiedFrom`. */
async function writeBack(run: { file: string; copy: string; copiedFrom: string; log: (line: string) => void }): Promise<void> {
  const now = await readFile(run.copy).catch(() => null);
  if (!now || sha256(now) === run.copiedFrom) return;
  if (now.length > MAX_LOGIN_BYTES) {
    run.log(`codex: the run's login copy is over 64 KB; kept the host's ${run.file}`);
    return;
  }
  let login: unknown;
  try {
    login = JSON.parse(now.toString("utf8"));
  } catch {
    run.log(`codex: the run's login copy is not JSON; kept the host's ${run.file}`);
    return;
  }
  const host = await readFile(run.file).catch(() => null);
  if (!host || sha256(host) !== run.copiedFrom) {
    run.log(`codex: the run refreshed its login, but ${run.file} changed meanwhile; kept the host's`);
    return;
  }
  // The sandbox could have written anything there: only a login with the host's top-level keys goes back.
  let was: unknown = null;
  try {
    was = JSON.parse(host.toString("utf8"));
  } catch {
    // A host file that is not JSON has no shape to match.
  }
  if (!isObject(login) || !isObject(was) || keysOf(login) !== keysOf(was)) {
    run.log(`codex: the run's login copy is not a Codex login like the host's (other top-level keys); kept the host's ${run.file}`);
    return;
  }
  const temp = `${run.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, now, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, run.file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  run.log(`codex: the run refreshed its login; wrote it back to ${run.file}`);
}
