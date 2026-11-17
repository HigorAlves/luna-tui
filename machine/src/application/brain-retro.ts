// What the retro's claims become (RFC 0010, "Remember"): the retro stage hands its drafts over and moves on; this puts them to admission with the
// card as their source. The retro's prompt is the text the quotes must be found in, since the retro quotes what it was shown.
import type { Admission } from "./brain-admission.ts";
import type { MemoryDeps } from "./stages/memory.ts";

export function retroClaims(admission: Pick<Admission, "propose">, log: (line: string) => void): NonNullable<MemoryDeps["claims"]> {
  return (context, drafts, prompt) => {
    const { task } = context;
    admission
      .propose(drafts, { taskId: task.id, repoPath: task.repoPath ?? null, extractor: "reviewing_memory", source: { kind: "card", ref: task.id, title: task.title }, sourceText: prompt, speaker: null, speakerTrust: "machine" })
      .catch((error: unknown) => log(`brain: the retro's claims were not admitted: ${error instanceof Error ? error.message : String(error)}`));
  };
}
