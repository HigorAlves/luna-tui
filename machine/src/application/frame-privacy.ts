// Whether the text read off a film or screenshots shows a credential or personal data, when no pattern said so: the typed decision frame_privacy.
// The machine flattens and caps what the model sees; the text is data, rendered as such by the decision's context.
import type { DecisionOverrides } from "@hardness/contracts";

import { redact } from "../domain/evidence-markdown.ts";
import { type TruthSink, frameCredentialTruth } from "./decision-truth.ts";
import { type Decide, judgeCheck } from "./stages/check-decide.ts";

const TEXTS_MAX = 40;
const TEXT_CAP = 1000;

/** The distinct on-screen texts, each on one line and at most 1000 characters, at most 40. */
export function privacyTexts(frames: readonly { text: string }[]): string[] {
  const seen = new Set<string>();
  for (const f of frames) {
    const flat = f.text.replace(/\s+/g, " ").trim().slice(0, TEXT_CAP);
    if (flat !== "") seen.add(flat);
    if (seen.size >= TEXTS_MAX) break;
  }
  return [...seen];
}

/** `clear` only for `none` at the proceed bar; `exposed` for anything else the decision says; `not_judged` when there is no decision to ask or it failed (the pattern check stands). */
export async function judgePrivacy(decide: Decide | null, overrides: Record<string, DecisionOverrides>, texts: string[], repoPath: string | null, teach?: { truth: TruthSink | null | undefined; taskId?: string | undefined }): Promise<"clear" | "exposed" | "not_judged"> {
  if (texts.length === 0) return "clear";
  const { verdict, answer, recordId } = await judgeCheck(decide, "frame_privacy", { kind: "frames", frames: { texts } }, repoPath, overrides);
  if (verdict === "skipped" || !answer) return "not_judged";
  // The secrets redactor matching the text is a fact: a credential was on screen. Not matching proves nothing.
  const derived = frameCredentialTruth(texts.some((text) => redact(text) !== text));
  if (derived && recordId && teach?.truth) await teach.truth.learned({ pack: "frame_privacy", recordId, label: derived.label, kind: derived.kind, source: derived.source, ...(teach.taskId ? { taskId: teach.taskId } : {}) }).catch(() => {});
  const exposure = answer.exposure as { choice?: unknown } | undefined;
  return exposure?.choice === "none" && verdict === "proceed" ? "clear" : "exposed";
}
