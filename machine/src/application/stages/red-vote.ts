// red_check is a small model that reads the scenario, the test's source and the writer's report of the failure. Its confident "no" has
// been wrong on the same input (S2 of a README rewrite: no, no, yes, no, with p .97-.99), so one answer is not a verdict. A scenario is
// asked once; only a flag is asked again, and it stands when most of up to three askings agree.
import type { CheckContext } from "@hardness/contracts";

export const RED_ASKINGS = 3;

export interface RedAnswer {
  verdict: string;
  problems: string[];
}

export type RedJudge = (check: CheckContext, repoPath: string | null) => Promise<RedAnswer>;

/** One asking's outcome: a flag is a verdict other than proceed or skipped, or any problem a confident no named. */
export const flagged = (answer: RedAnswer): boolean => answer.problems.length > 0 || (answer.verdict !== "proceed" && answer.verdict !== "skipped");

export interface RedVote {
  /** `proceed`, `skipped` (the one asking that was made did not answer) or `flag`. */
  verdict: string;
  /** What the flagged askings said was wrong, each once. */
  problems: string[];
  /** The askings made, in order: what each said. */
  askings: { flagged: boolean; verdict: string; problems: string[] }[];
}

/** Asks until the majority is settled: a first answer that is not a flag stands; a flag is asked again, and a second flag stands; a split asks a third time. */
export async function voteRed(judge: RedJudge, check: CheckContext, repoPath: string | null): Promise<RedVote> {
  const askings: RedVote["askings"] = [];
  for (let n = 0; n < RED_ASKINGS; n++) {
    const answer = await judge(check, repoPath);
    askings.push({ flagged: flagged(answer), verdict: answer.verdict, problems: answer.problems });
    const flags = askings.filter((a) => a.flagged).length;
    const clear = askings.length - flags;
    if (flags > RED_ASKINGS / 2) break;
    if (clear > RED_ASKINGS / 2) break;
    // One asking that did not flag is settled at once: the common path is one call.
    if (askings.length === 1 && flags === 0) break;
  }
  const flags = askings.filter((a) => a.flagged);
  if (flags.length * 2 > askings.length) {
    const problems = [...new Set(flags.flatMap((a) => a.problems))];
    return { verdict: "flag", problems, askings };
  }
  const last = askings.at(-1)!;
  return { verdict: last.verdict === "skipped" ? "skipped" : "proceed", problems: [], askings };
}
