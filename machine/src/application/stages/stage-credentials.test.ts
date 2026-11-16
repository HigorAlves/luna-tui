import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CredentialWaitError, type Credentials, NoCredentialError } from "../../adapters/credentials/index.ts";
import { HELPER_CREDENTIAL_WAIT_MS, prepareStageCredentials } from "./stage-credentials.ts";

/** Credentials that record what was prepared and released; `missing` engines are not here, `busy` ones wait out. */
function recording({ missing = [] as string[], busy = [] as string[], held = [] as string[] } = {}) {
  const log: string[] = [];
  const waits: Array<number | undefined> = [];
  const credentials: Credentials = {
    check: async (engine) => (held.includes(engine) ? { available: false, reason: `${engine} is disabled`, code: "disabled" } : { available: true }),
    prepare: async (engine, _runDir, wait) => {
      waits.push(wait?.timeoutMs);
      if (missing.includes(engine)) throw new NoCredentialError(`no ${engine} here`);
      if (busy.includes(engine)) throw new CredentialWaitError(`waited for ${engine}`);
      log.push(`prepare ${engine}`);
      const key = `KEY_${engine.replace(/\W/g, "_").toUpperCase()}`;
      return { env: { [key]: "v" }, mounts: [{ host: `/h/${engine}`, container: `/c/${engine}`, readOnly: false }], release: async () => void log.push(`release ${engine}`) };
    },
  };
  return { credentials, log, waits };
}

describe("prepareStageCredentials", () => {
  it("gives verifying the Claude token and the Codex login its second opinion needs, each released after", async () => {
    const { credentials, log, waits } = recording();
    const credential = await prepareStageCredentials(credentials, PACKS.verifying, "claude:opus", "/run", { timeoutMs: 20 * 60_000 });
    expect(credential.env).toEqual({ KEY_CLAUDE_OPUS: "v", KEY_CODEX_SOL: "v" });
    expect(credential.mounts.map((m) => m.container)).toEqual(["/c/claude:opus", "/c/codex:sol"]);
    // The stage waits its own timeout for its engine, a helper's credential only a short while.
    expect(waits).toEqual([20 * 60_000, HELPER_CREDENTIAL_WAIT_MS]);
    await credential.release();
    expect(log).toEqual(["prepare claude:opus", "prepare codex:sol", "release claude:opus", "release codex:sol"]);
  });

  it("prepares the helper's credential for the engine's runtime: triage on Codex needs the Codex login, not a Claude token", async () => {
    const { credentials, log } = recording();
    await prepareStageCredentials(credentials, PACKS.triage, "codex:sol", "/run");
    expect(log).toEqual(["prepare codex:sol"]);
    log.length = 0;
    await prepareStageCredentials(credentials, PACKS.verifying, "codex:sol", "/run");
    expect(log).toEqual(["prepare codex:sol", "prepare claude:opus"]);
  });

  it("takes each credential once: a helper on the stage's own credential adds nothing", async () => {
    const { credentials, log } = recording();
    await prepareStageCredentials(credentials, PACKS.reviewing, "claude:opus", "/run");
    await prepareStageCredentials(credentials, PACKS.triage, "claude:opus", "/run");
    expect(log).toEqual(["prepare claude:opus", "prepare claude:opus"]);
  });

  it("runs without a helper's credential that is missing, held back or busy, and says so on the task", async () => {
    const cases: Array<[Parameters<typeof recording>[0], string]> = [
      [{ missing: ["codex:sol"] }, "no codex:sol here"],
      [{ held: ["codex:sol"] }, "codex:sol is disabled"],
      [{ busy: ["codex:sol"] }, "waited for codex:sol"],
    ];
    for (const [opts, why] of cases) {
      const { credentials, log } = recording(opts);
      const notes: string[] = [];
      const credential = await prepareStageCredentials(credentials, PACKS.verifying, "claude:opus", "/run", { note: (line) => notes.push(line) });
      expect(credential.env).toEqual({ KEY_CLAUDE_OPUS: "v" });
      expect(log).toEqual(["prepare claude:opus"]);
      expect(notes).toEqual([`verifying's second-opinion on codex:sol is not available in this run: ${why}`]);
    }
  });

  it("fails as before when the stage's own credential is missing, and prepares no helper's", async () => {
    const { credentials, log } = recording({ missing: ["claude:opus"] });
    await expect(prepareStageCredentials(credentials, PACKS.verifying, "claude:opus", "/run")).rejects.toThrow(/no claude:opus here/);
    expect(log).toEqual([]);
  });
});
