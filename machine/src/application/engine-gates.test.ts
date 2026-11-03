import type { EngineId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { Credentials } from "../adapters/credentials/index.ts";
import { DISABLED_REASON, gatedCredentials, runtimeKillSwitch } from "./engine-gates.ts";

/** Every credential present, except `missing`; `prepare` says which engine it prepared. */
const inner = (missing: EngineId[] = []): Credentials => ({
  check: async (engine) => (missing.includes(engine) ? { available: false, reason: "no Codex login" } : { available: true }),
  prepare: async (engine) => ({ env: { ENGINE: engine }, mounts: [], release: async () => {} }),
});

describe("the runtime kill switch", () => {
  it("makes every engine on a disabled runtime unavailable, saying so, and leaves the rest to their credential", async () => {
    const credentials = gatedCredentials(inner(["codex:luna"]), [runtimeKillSwitch(["jev"])]);
    expect(await credentials.check("jev")).toEqual({ available: false, code: "disabled", reason: DISABLED_REASON });
    expect(DISABLED_REASON).toBe("disabled by MACHINE_DISABLE_RUNTIMES");
    expect(await credentials.check("codex:sol")).toEqual({ available: true });
    expect(await credentials.check("codex:luna")).toEqual({ available: false, reason: "no Codex login" });
    expect(await credentials.check("claude:opus")).toEqual({ available: true });
  });

  it("covers both eve engines, Codex and OpenAI, when eve is off", async () => {
    const credentials = gatedCredentials(inner(), [runtimeKillSwitch(["eve"])]);
    for (const engine of ["codex:sol", "codex:luna", "openai:sol", "openai:luna"] as const) {
      expect(await credentials.check(engine)).toMatchObject({ available: false, code: "disabled" });
    }
    expect(await credentials.check("jev")).toEqual({ available: true });
  });

  it("passes prepare through: the choice already kept a disabled engine from running", async () => {
    const credentials = gatedCredentials(inner(), [runtimeKillSwitch(["eve"])]);
    expect((await credentials.prepare("claude:opus", "/tmp/run")).env).toEqual({ ENGINE: "claude:opus" });
  });
});
