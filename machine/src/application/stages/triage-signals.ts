// Triage's first step for every source: the triage_signals decision, run on each entry to the stage (the first
// run and each return from awaiting_answers) with the answers so far in the issue it reads. The reading replaces
// the card's classification; a classifier that is absent, fails or answers nothing leaves the previous one and
// says so, and triage goes on.
import { type ClassifyOptions, type DecisionOverrides, FACTORY_DEFAULTS, type FactoryConfig, type IssueContext, type NeedsInputItem, RecordDraft, type TaskClassification, TriageOutcome, TriageRecord } from "@hardness/contracts";

import { type Located, fastLane, ownersCheck } from "../../domain/fast-lane.ts";
import { goalRefOf } from "../../domain/goal-ref.ts";
import { composeRecord, recordComplete } from "../../domain/triage-record.ts";
import { askedQuestions, triageVerdicts } from "../../domain/triage-policy.ts";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export interface TriageSignalDeps {
  /** The classifier, once it exists (late-bound in main.ts); null when there is no Jev or fallback credential or agents are off. */
  classify: ((issue: IssueContext, repoPath: string | null, options?: ClassifyOptions) => Promise<TaskClassification | null>) | null;
  /** The repo's policy: its scoring weights and bands turn the sub-scores into a priority, its confidence bars decide what is asked. Absent: the diagram's. */
  policy?: (repoPath: string) => Promise<{ factory: FactoryConfig; decisions?: Record<string, DecisionOverrides> }>;
  /** The code graph, for the owners the fast-lane rule reads; absent (or a repo without one) skips that condition. */
  graph?: { locate(repoPath: string, text: string, options?: { staleCommits?: number }): Promise<Exclude<Located, "failed" | null> | null> };
  save: (id: string, patch: Partial<TaskRow>) => Promise<void>;
  log?: (line: string) => void;
}

const MAX_ANSWERS = 20;

/** How many rounds of questions triage has put to the person so far: its own gates, not test design's. */
const roundsOf = (approvals: StageContext["approvals"]): number => approvals.filter((a) => a.kind === "awaiting_answers" && (a.requested as { askedBy?: unknown } | undefined)?.askedBy === "triage").length;
const MAX_ANSWER_CHARS = 2000;

const issueOf = (task: TaskRow, answers: NonNullable<IssueContext["answers"]>): IssueContext => {
  const source = task.source;
  const ref = source && "url" in source ? source.url : source?.kind === "slack" ? source.permalink : undefined;
  return { title: task.title, description: task.description, labels: [], ...(ref ? { source: ref } : {}), ...(answers.length > 0 ? { answers } : {}) };
};

/** What the person answered at the questions gates so far, oldest first; an answer that is not text is dropped. */
function answersOf(approvals: StageContext["approvals"]): NonNullable<IssueContext["answers"]> {
  return approvals
    .flatMap((a) => {
      if (a.decision !== "answered") return [];
      return Object.entries((a.response?.answers ?? {}) as Record<string, unknown>).flatMap(([question, answer]) => (typeof answer === "string" ? [{ question: question.slice(0, MAX_ANSWER_CHARS), answer: answer.slice(0, MAX_ANSWER_CHARS) }] : []));
    })
    .slice(0, MAX_ANSWERS);
}

/** The record the machine composes around triage's words: null only when there is no valid draft. A record missing a field is returned as it is; `recordComplete` says what. */
function recordOf(context: StageContext, result: StageResult, task: TaskRow, decision: TriageOutcome, ownersNotChecked?: string): Partial<TriageRecord> | null {
  const draft = RecordDraft.safeParse(result.detail?.record);
  if (!draft.success) return null;
  const qa = context.approvals.flatMap((a) => {
    if (a.decision !== "answered") return [];
    const answers = (a.response?.answers ?? {}) as Record<string, unknown>;
    return Object.entries(answers).map(([question, answer]) => ({ question, answer: typeof answer === "string" ? answer : null }));
  });
  return composeRecord({
    draft: draft.data,
    ...(typeof result.detail?.summary === "string" ? { summary: result.detail.summary } : {}),
    classification: task.classification,
    source: task.source?.kind ?? "manual",
    decision,
    qa,
    goalRef: goalRefOf({ text: `${task.title}\n${task.description}` }),
    previous: task.record,
    ...(decision === "fast_lane" && ownersNotChecked ? { ownersNotChecked } : {}),
    model: result.run?.info?.modelId ?? "unknown",
    at: new Date().toISOString(),
  });
}

export function withTriageSignals(triage: StageRunner, deps: TriageSignalDeps): StageRunner {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (context) => {
    const { task } = context;
    const rounds = roundsOf(context.approvals);
    let classification: TaskClassification | null = null;
    const repo = (task.repoPath ? await deps.policy?.(task.repoPath).catch(() => null) : null) ?? null;
    if (deps.classify) {
      const kept = task.classification ? "the previous reading is kept" : "going on without one";
      try {
        const options: ClassifyOptions = repo ? { weights: repo.factory.scoring.weights, bands: repo.factory.scoring.bands } : {};
        classification = await deps.classify(issueOf(task, answersOf(context.approvals)), task.repoPath, options);
        if (classification) await deps.save(task.id, { classification });
        else await context.note?.(`triage signals gave no reading; ${kept}`).catch(() => {});
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        log(`triage signals for task ${task.id}: ${why}`);
        await context.note?.(`triage signals failed (${why}); ${kept}`).catch(() => {});
        classification = null;
      }
    }
    const caps = (repo?.factory ?? FACTORY_DEFAULTS).triage;
    /** Questions for the person: at most `max_questions` a round, and past `max_rounds` a person is asked to take over instead. */
    const ask = (questions: NeedsInputItem[], asked?: Array<{ field: string; guess: string; confidence: number }>, from?: StageResult): StageResult => {
      if (rounds >= caps.max_rounds) {
        const open = questions.map((q) => q.question).join("; ");
        return { ...(from ?? {}), outcome: "escalated", needsInput: undefined, detail: { ...from?.detail, reason: `triage still needs answers after ${rounds} rounds of questions: ${open}`, escalation: "other" } };
      }
      const kept = questions.slice(0, caps.max_questions);
      return {
        ...(from ?? {}),
        outcome: "needs_input",
        needsInput: kept,
        detail: { ...(from?.detail ?? { summary: `${questions.length} signal${questions.length === 1 ? " is" : "s are"} under the confidence bar: ${asked?.map((a) => a.field).join(", ")}` }), askedBy: "triage", ...(asked ? { asked: asked.slice(0, caps.max_questions) } : {}) },
      };
    };
    const enriched = classification ? { ...context, task: { ...task, classification } } : context;
    // A field under its flag bar is the person's to settle, not the agent's: the stage stops and asks, and the signals
    // are read again with the answers. Only a reading taken this time can ask.
    if (classification) {
      const verdicts = triageVerdicts(classification, (repo?.factory ?? FACTORY_DEFAULTS).triage, { ...(repo?.decisions?.triage_signals ? { overrides: repo.decisions.triage_signals } : {}) });
      const asked = askedQuestions(verdicts).sort((x, y) => x.confidence - y.confidence);
      if (asked.length > 0) return ask(asked.map(({ question, recommended }) => ({ question, recommended })), asked.map(({ field, guess, confidence }) => ({ field, guess, confidence })));
    }
    /** The decision: the agent's own for a reply or an archive; otherwise `fast_lane` only when the machine's rule says so, else `plan`. */
    const laneOf = async (ctx: StageContext, res: StageResult): Promise<{ decision: TriageOutcome; note?: string | undefined; ownersNotChecked?: string | undefined }> => {
      const said = TriageOutcome.safeParse(res.detail?.outcome);
      if (said.success && (said.data === "conversation" || said.data === "archive")) return { decision: said.data };
      const c = ctx.task.classification;
      if (!c?.sizeBucket || !c.riskPrelim || !c.typeOfWork) return { decision: "plan" };
      const fastConfig = (repo?.factory ?? FACTORY_DEFAULTS).fast_lane;
      const verdicts = triageVerdicts(c, caps, { ...(repo?.decisions?.triage_signals ? { overrides: repo.decisions.triage_signals } : {}) });
      let located: Located = null;
      if (deps.graph && task.repoPath) {
        located = await deps.graph.locate(task.repoPath, `${task.title}\n${task.description}`, { staleCommits: (repo?.factory ?? FACTORY_DEFAULTS).graph.stale_commits }).catch((): Located => "failed");
      }
      const lane = fastLane({ riskPrelim: c.riskPrelim, size: c.sizeBucket, typeOfWork: c.typeOfWork }, ownersCheck(located), fastConfig, verdicts);
      return lane.fast
        ? { decision: "fast_lane", ...(lane.ownersNotChecked ? { note: `owners not checked: ${lane.ownersNotChecked}`, ownersNotChecked: lane.ownersNotChecked } : {}) }
        : { decision: "plan", note: `not the fast lane: ${lane.failing}` };
    };
    /** One run of the agent, its questions held to the bounds. */
    const runAgent = async (ctx: StageContext): Promise<StageResult> => {
      const agent = await triage(ctx);
      return agent.outcome === "needs_input" && agent.needsInput?.length ? ask(agent.needsInput, undefined, agent) : agent;
    };
    let result = await runAgent(enriched);
    let finalContext = enriched;
    if (result.outcome === "pass") {
      // The machine composes the record and checks it: an incomplete one sends the agent round once with what is missing, then a person decides.
      const lane = await laneOf(finalContext, result);
      let record = recordOf(finalContext, result, finalContext.task, lane.decision, lane.ownersNotChecked);
      let check = recordComplete(record);
      if (!check.complete) {
        const guidance = { id: "triage-record", taskId: task.id, kind: "triage", requested: {}, decision: "sent_back", reason: `The record you wrote is incomplete: ${check.missing.join(", ")}. Write the summary (at most 120 words), the goal sentence, the decision and the reason in full.`, response: null, createdAt: new Date(), decidedAt: new Date() } as unknown as StageContext["approvals"][number];
        finalContext = { ...enriched, approvals: [...enriched.approvals, guidance] };
        result = await runAgent(finalContext);
        if (result.outcome === "pass") {
          const again = await laneOf(finalContext, result);
          lane.decision = again.decision;
          lane.note = again.note;
          lane.ownersNotChecked = again.ownersNotChecked;
          record = recordOf(finalContext, result, finalContext.task, lane.decision, lane.ownersNotChecked);
          check = recordComplete(record);
          if (!check.complete) return { ...result, outcome: "escalated", detail: { ...result.detail, reason: `triage could not write a complete Triage Record: missing ${check.missing.join(", ")}`, escalation: "other" } };
        }
      }
      if (result.outcome === "pass" && record) {
        const parsed = TriageRecord.safeParse(record);
        if (!parsed.success) return { ...result, outcome: "escalated", detail: { ...result.detail, reason: "triage could not write a valid Triage Record", escalation: "other" } };
        try {
          await deps.save(task.id, { record: parsed.data });
        } catch (error) {
          log(`triage record for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        // The lane is the machine's: `detail.outcome` is what the pipeline and the card.fast_lane fact read.
        result = { ...result, detail: { ...result.detail, outcome: lane.decision, ...(lane.note ? { laneNote: lane.note } : {}) } };
        // The card.triaged event carries the number of the record it replaces, not the record.
        if (task.record) result = { ...result, detail: { ...result.detail, previousVersion: task.record.version ?? 1 } };
      }
    }
    return result;
  };
}
