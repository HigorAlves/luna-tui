// The Codex (ChatGPT) login for `codex:*` engines. The Codex CLI owns `~/.codex/auth.json` and
// rewrites it when it refreshes the token, so each run gets its own copy: `<runDir>/codex/auth.json`
// (0600, in a 0700 folder), mounted writable at /tmp/.codex with CODEX_HOME pointing there. Once
// the container is gone, a copy the run refreshed goes back to the host, atomically, but only
// while the host file still holds what was copied; one changed meanwhile (you logged in again,
// another run wrote back first) is kept. The copy is deleted either way. See RFC 0002.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type CredentialLoader, type CredentialOptions, NoCredentialError, type RunCredential } from "./credential.ts";

/** Where the stage's Codex home is mounted: on the tmpfs, beside the HOME the container gets. */
export const CONTAINER_CODEX_HOME = "/tmp/.codex";
/** The run's copy lives in this folder under its run dir; the hash of what was copied sits beside it, outside the mount. */
const COPY_DIR = "codex";
const BASE_FILE = "codex-auth.sha256";

/** Where the Codex CLI keeps its login: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(opts: CredentialOptions = {}): string {
  return (opts.env ?? process.env).CODEX_HOME || join(opts.home ?? homedir(), ".codex");
}

const sha256 = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");

/** Write-backs run one at a time, so two runs that both refreshed cannot both pass the host-file check. */
let writeBacks: Promise<void> = Promise.resolve();
function oneAtATime(task: () => Promise<void>): Promise<void> {
  const next = writeBacks.then(task, task);
  writeBacks = next.catch(() => {});
  return next;
}

export function codexCredentials(opts: CredentialOptions = {}): CredentialLoader {
  const file = join(codexHome(opts), "auth.json");
  const log = opts.log ?? ((line: string) => console.log(line));
  const missing = `no Codex login: ${file} is missing or unreadable (run \`codex login\`)`;
  return {
    async check() {
      try {
        await access(file, constants.R_OK);
        return { available: true };
      } catch {
        return { available: false, reason: missing };
      }
    },
    async prepare(runDir): Promise<RunCredential> {
      const dir = join(runDir, COPY_DIR);
      const copy = join(dir, "auth.json");
      const baseFile = join(runDir, BASE_FILE);
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
      const copiedFrom = base;
      return {
        env: { CODEX_HOME: CONTAINER_CODEX_HOME },
        mounts: [{ host: dir, container: CONTAINER_CODEX_HOME, readOnly: false }],
        release: () => oneAtATime(() => writeBack({ file, copy, copiedFrom, log }).finally(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(baseFile, { force: true })]).then(() => {}))),
      };
    },
  };
}

/** The compare-and-swap: the run's copy goes to `file` only when it changed, reads as JSON, and the host file is still `copiedFrom`. */
async function writeBack(run: { file: string; copy: string; copiedFrom: string; log: (line: string) => void }): Promise<void> {
  const now = await readFile(run.copy).catch(() => null);
  if (!now || sha256(now) === run.copiedFrom) return;
  try {
    JSON.parse(now.toString("utf8"));
  } catch {
    run.log(`codex: the run's login copy is not JSON; kept the host's ${run.file}`);
    return;
  }
  const host = await readFile(run.file).catch(() => null);
  if (!host || sha256(host) !== run.copiedFrom) {
    run.log(`codex: the run refreshed its login, but ${run.file} changed meanwhile; kept the host's`);
    return;
  }
  const temp = `${run.file}.${randomUUID()}.tmp`;
  await writeFile(temp, now, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, run.file);
  run.log(`codex: the run refreshed its login; wrote it back to ${run.file}`);
}
