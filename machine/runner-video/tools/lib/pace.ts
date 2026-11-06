// How long a recorded scene should hold, for the recorder's fixture. The recorder runs at the same time as the voice, so it paces by the
// timeline (the plan: a scene's end minus its start); a narration file, when one is there, still wins. Pure.

interface Planned {
  scenes: { id: string; start: number; end: number }[];
}
interface Clips {
  scenes: { id: string; durationS: number }[];
}

/** A scene's planned length in milliseconds: its `end - start` on the timeline. */
export function plannedMs(timeline: Planned, scene: string): number {
  const found = timeline.scenes.find((s) => s.id === scene);
  if (!found) throw new Error(`the timeline has no scene "${scene}"`);
  return Math.round((found.end - found.start) * 1000);
}

/** The time the demo should take for a scene: the narration clip's length when the narration names the scene, else the timeline's plan. */
export function durationFor(scene: string, sources: { narration: Clips | null; timeline: Planned | null }): number {
  const clip = sources.narration?.scenes.find((s) => s.id === scene);
  if (clip) return Math.round(clip.durationS * 1000);
  if (sources.timeline?.scenes.some((s) => s.id === scene)) return plannedMs(sources.timeline, scene);
  throw new Error(`no narration or plan for scene "${scene}"`);
}
