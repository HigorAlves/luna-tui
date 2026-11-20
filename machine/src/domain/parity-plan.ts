// The capture plan (RFC 0013, phase 3): which scenario captures which state at which viewport, from the approved scenarios and the design spec. Pure.
import { type CapturePlan, type CaptureTarget, type DesignSpec, MAX_CAPTURES, type Scenario, captureKey } from "@hardness/contracts";

type Cited = Pick<Scenario, "title" | "layer" | "frame_ref"> & { id?: string | undefined };

/**
 * One target per state of each frame a browser scenario cites (`frame_ref`), at the frame's own viewport, named `${width}x${height}`.
 * A state the file only suggests has no design to compare with, so it is not captured; a frame that lists no designed state is captured as `default`.
 * `uncited` is every spec frame no kept scenario cites, in spec order. Browser scenarios are chosen as the e2e stage chooses them: layer `e2e`, or all when the plan has no layers.
 */
export function capturePlan(scenarios: Cited[], spec: DesignSpec | null): CapturePlan {
  const plan: CapturePlan = { targets: [], uncited: [], notes: [] };
  if (!spec) return plan;
  const layered = scenarios.some((s) => s.layer);
  const kept = scenarios.filter((s) => !layered || s.layer === "e2e");
  const cited = new Set<string>();
  const seen = new Set<string>();
  let over = 0;
  for (const scenario of kept) {
    const id = scenario.frame_ref;
    if (!id) continue;
    const frame = spec.frames.find((f) => f.id === id);
    if (!frame) {
      plan.notes.push(`${scenario.id ?? scenario.title} cites ${id}, which the spec does not name`);
      continue;
    }
    cited.add(id);
    if (!frame.viewport) {
      plan.notes.push(`${scenario.id ?? scenario.title} cites ${id}, which has no viewport in the spec: nothing to capture`);
      continue;
    }
    const designed = frame.states.filter((s) => s.nodeId !== null).map((s) => s.state);
    for (const state of designed.length > 0 ? designed : (["default"] as const)) {
      const target: CaptureTarget = { scenario: scenario.id ?? "", frame: id, viewport: { name: `${frame.viewport.width}x${frame.viewport.height}`, ...frame.viewport }, state };
      const key = captureKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      if (plan.targets.length >= MAX_CAPTURES) over++;
      else plan.targets.push(target);
    }
  }
  plan.uncited = spec.frames.filter((f) => !cited.has(f.id)).map((f) => f.id);
  if (over > 0) plan.notes.push(`${over} captures over the cap of ${MAX_CAPTURES} were not planned`);
  return plan;
}
