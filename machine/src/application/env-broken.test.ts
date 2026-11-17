import { describe, expect, it } from "vitest";

import { GuardStartError } from "../adapters/docker/guard.ts";
import { envBrokenDetail } from "./env-broken.ts";

describe("envBrokenDetail", () => {
  it("maps a guard that would not start to env_broken, step guard, with the reason and a way out that is not running unguarded", () => {
    const detail = envBrokenDetail(new GuardStartError("Unable to find image 'hardness-runner-guard:dev' locally"))!;
    expect(detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "guard", reason: expect.stringContaining("Unable to find image") });
    expect(detail.options).toEqual([expect.stringMatching(/pnpm images.*resume/s)]);
    expect(JSON.stringify(detail.options)).not.toMatch(/unguarded|without the guard/i);
  });

  it("leaves other errors to the caller", () => {
    expect(envBrokenDetail(new Error("boom"))).toBeNull();
  });
});
