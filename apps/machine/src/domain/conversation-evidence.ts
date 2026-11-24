// What a card's Evidence Pack gives a reply draft: an allowlist of fields, each flattened, masked and capped. Anything else in the pack (findings, the
// out-of-map list, rollback and verification steps, the commit, media and local paths, the video's details) never reaches the context. Pure.
import type { EvidencePack } from "@hardness/contracts";

import { maskPii } from "./secrets-check.ts";

const SUMMARY_CAP = 600;
const flat = (text: string, cap: number): string => maskPii(text).replace(/\s+/g, " ").trim().slice(0, cap);

export function evidenceView(pack: EvidencePack | null): string | null {
  if (!pack) return null;
  const count = (result: string): number => pack.scenarios.filter((s) => s.result === result).length;
  return `Summary: ${flat(pack.summary, SUMMARY_CAP)}. Format: ${pack.format}. Results: ${count("pass")} pass, ${count("fail")} fail, ${count("partial")} partial, ${count("skipped")} skipped.`.replace(/\.\./g, ".");
}
