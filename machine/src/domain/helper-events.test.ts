import { describe, expect, it } from "vitest";

import { EMITTABLE } from "../application/ports.ts";
import { HELPER_EVENT_KINDS, helperEnded } from "./helper-events.ts";
import { isReservedKind } from "./reserved-kinds.ts";
import { STAGE_REPORTS } from "./card-events.ts";

describe("the ui-designer's rows", () => {
  it("are the machine's own: emittable by a stage runner, reserved against a container, and not a container-reportable name", () => {
    expect(HELPER_EVENT_KINDS).toEqual(["build.helper_started", "build.helper_refused", "build.helper_conflict", "build.helper_picked", "build.helper_ended"]);
    for (const kind of HELPER_EVENT_KINDS) {
      expect((EMITTABLE as readonly string[]).includes(kind), kind).toBe(true);
      expect(isReservedKind(kind), kind).toBe(true);
      expect(STAGE_REPORTS.has(kind), kind).toBe(false);
    }
  });

  it("builds the helper_ended payload from the run's own numbers: tokens are input plus output, or null when the runtime did not count", () => {
    expect(helperEnded(2, 1, { outcome: "pass", usage: { tokens: { input: 300, output: 50 } } } as never, 12.34)).toEqual({ slice: 2, attempt: 1, outcome: "pass", tokens: 350, minutes: 12.3 });
    expect(helperEnded(3, 2, { outcome: "fail" } as never, 4)).toEqual({ slice: 3, attempt: 2, outcome: "fail", tokens: null, minutes: 4 });
  });
});
