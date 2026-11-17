// What the retro's claims become (RFC 0010, "Remember"): the retro stage hands its drafts over and moves on; this puts them to admission with the
// card as their source. The retro's prompt is the text the quotes must be found in, since the retro quotes what it was shown.
import type { ClaimSpeakerTrust } from "@hardness/contracts";

import type { TaskRow } from "../domain/task.ts";
import { trustOf } from "../domain/trust.ts";
import type { Admission } from "./brain-admission.ts";
import type { MemoryDeps } from "./stages/memory.ts";

/**
 * Whose words the card's text holds, by the machine's one trust rule (`trustOf`): `outside` for a GitHub issue or PR whose author is
 * not the repository's own people or has no recorded association, `machine` for every other card. Jira and Slack are the org's own
 * tools, as they are for the sandbox: the card keeps no author for them, so a guest there is not told apart.
 */
export function speakerTrustOf(task: Pick<TaskRow, "source">): ClaimSpeakerTrust {
  return trustOf(task) === "untrusted" ? "outside" : "machine";
}

export function retroClaims(admission: Pick<Admission, "propose">, log: (line: string) => void, trustOfTask: (task: TaskRow) => Promise<ClaimSpeakerTrust>): NonNullable<MemoryDeps["claims"]> {
  return (context, drafts, prompt) => {
    const { task } = context;
    // A lookup that fails is an outsider: the claim then waits for a person.
    const speakerTrust = trustOfTask(task).catch((): ClaimSpeakerTrust => "outside");
    speakerTrust
      .then((trust) => admission.propose(drafts, { taskId: task.id, repoPath: task.repoPath ?? null, extractor: "reviewing_memory", source: { kind: "card", ref: task.id, title: task.title }, sourceText: prompt, speaker: null, speakerTrust: trust }))
      .catch((error: unknown) => log(`brain: the retro's claims were not admitted: ${error instanceof Error ? error.message : String(error)}`));
  };
}
