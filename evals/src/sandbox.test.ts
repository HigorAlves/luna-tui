import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { evalSandbox } from "./sandbox.ts";

describe("evalSandbox", () => {
  it("runs an eval as trusted, as a pipeline stage does", () => {
    expect(evalSandbox("triage", true).trust).toBe("trusted");
  });

  it("gives the pack's own egress list, not the agent list for every pack", () => {
    const network = (id: keyof typeof PACKS) => (PACKS[id] as { network?: string }).network;
    const engineOnly = (Object.keys(PACKS) as Array<keyof typeof PACKS>).find((id) => network(id) === "engine");
    const github = (Object.keys(PACKS) as Array<keyof typeof PACKS>).find((id) => network(id) === "github");
    expect(engineOnly && evalSandbox(engineOnly, true).egressKind).toBe("pack");
    expect(github && evalSandbox(github, true).egressKind).toBe("github");
    expect(evalSandbox("risk_score", true).egressKind).toBe("agent");
  });

  it("passes the machine's relay setting to the credentials, on and off", () => {
    expect(evalSandbox("triage", true).credentials).toEqual({ engineRelay: true });
    expect(evalSandbox("triage", false).credentials).toEqual({ engineRelay: false });
  });

  it("runs a browser pack in the QA image and the others in the stage image", () => {
    expect(evalSandbox("a11y_audit", false)).toMatchObject({ image: "qa" });
    expect(evalSandbox("e2e", false)).toMatchObject({ image: "qa" });
    expect(evalSandbox("design_spec", false)).toMatchObject({ image: "stage" });
    expect(evalSandbox("triage", false)).toMatchObject({ image: "stage" });
  });
});
