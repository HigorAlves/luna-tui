// Triage's first step for every source: the triage_signals decision, run on each entry to the stage (the first
// run and each return from awaiting_answers) with the answers so far in the issue it reads. The reading replaces
// the card's classification; a classifier that is absent, fails or answers nothing leaves the previous one and
// says so, and triage goes on.
import { type ClassifyOptions, type DecisionOverrides, FACTORY_DEFAULTS, type FactoryConfig, type IssueContext, type NeedsInputItem, QuestionCouncilAnswer, type QuestionsContext, RecordDraft, type TaskClassification, TriageOutcome, TriageRecord } from "@hardness/contracts";

import { type Located, fastLane, ownersCheck } from "../../domain/fast-lane.ts";
import { goalRefOf } from "../../domain/goal-ref.ts";
import { trustOf } from "../../domain/trust.ts";
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
  /** The question council (the `question_council` pack as a sub-run): settles open questions from the code before the person is asked. Absent: the person is asked, as before. */
  council?: ((context: StageContext, questions: QuestionsContext) => Promise<StageResult>) | undefined;
}

/** A question the council settled: its answer, how sure it was and the places it read. */
interface Settled {
  question: string;
  answer: string;
  confidence: number;
  evidence: string[];
  /** The machine's field this question was (`kind`, `size`, `risk`); absent for the agent's own questions. */
  field?: string;
}

/** Results of an entry that ran again after the council settled something: the stage is over for the entry that asked. */
const finished = new WeakSet<StageResult>();

/** Urgency and archive are never the council's: they always reach the person. */
const COUNCIL_FIELDS = new Set(["kind", "size", "risk"]);
/** The name a field has in a repo's `policy.decisions.triage_signals`. */
const QUESTION_OF: Record<string, string> = { kind: "kind", size: "size", risk: "risk_prelim" };
/** The council reads at most this many questions in one run. */
const MAX_COUNCIL_QUESTIONS = 6;

const settledOf = (a: StageContext["approvals"][number]): Settled[] => {
  const list = (a.requested as { settledByCouncil?: unknown } | undefined)?.settledByCouncil;
  return a.decision === "answered" && Array.isArray(list) ? (list as Settled[]) : [];
};

/** What the council settled at the gates so far, by question. */
const councilAnswersOf = (approvals: StageContext["approvals"]): Map<string, Settled> => new Map(approvals.flatMap(settledOf).map((s) => [s.question, s]));

/** An answered gate carries what the council settled beside what the person answered: both are read as the person's answers are. The person's own answer to a question wins. */
const withCouncilAnswers = (approvals: StageContext["approvals"]): StageContext["approvals"] =>
  approvals.map((a) => {
    const settled = settledOf(a);
    if (settled.length === 0) return a;
    return { ...a, response: { ...a.response, answers: { ...Object.fromEntries(settled.map((s) => [s.question, s.answer])), ...((a.response?.answers ?? {}) as Record<string, unknown>) } } };
  });

const MAX_ANSWERS = 20;

/** How many rounds of questions triage has put to the person so far: its own gates, not test design's. */
const roundsOf = (approvals: StageContext["approvals"]): number => approvals.filter((a) => a.kind === "awaiting_answers" && (a.requested as { askedBy?: unknown } | undefined)?.askedBy === "triage").length;
const MAX_ANSWER_CHARS = 2000;

const issueOf = (task: TaskRow, answers: NonNullable<IssueContext["answers"]>): IssueContext => {
  const source = task.source;
  // The source labels the card was taken in with: a `security` label must still knock the reading out to P0.
  const sourceLabels = source && (source.kind === "github" || source.kind === "github_alert" || source.kind === "incident" || source.kind === "jira") ? (source.labels ?? []) : [];
  const ref = source && "url" in source ? source.url : source?.kind === "slack" ? source.permalink : undefined;
  return { title: task.title, description: task.description, labels: sourceLabels, ...(ref ? { source: ref } : {}), ...(answers.length > 0 ? { answers } : {}) };
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
  const council = councilAnswersOf(context.approvals);
  const qa = context.approvals.flatMap((a) => {
    if (a.decision !== "answered") return [];
    const answers = (a.response?.answers ?? {}) as Record<string, unknown>;
    return Object.entries(answers).map(([question, answer]) => {
      const text = typeof answer === "string" ? answer : null;
      const by = council.get(question);
      // The council's mark stays only while the answer is the council's: a person who answered the same question owns it.
      return by && by.answer === text ? { question, answer: text, by: "council" as const, evidence: by.evidence, ...(by.field ? { field: by.field } : {}) } : { question, answer: text };
    });
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
  /** One entry to the stage. The council runs at most once in it: what it settles is read as answers, and the entry runs again with them. */
  const entry = async (raw: StageContext, council: { ran: boolean; settled: Settled[]; carry: Array<{ question: NeedsInputItem; asked: { field: string; guess: string; confidence: number } }> }): Promise<StageResult> => {
    const context: StageContext = { ...raw, approvals: withCouncilAnswers(raw.approvals) };
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
    const ask = async (questions: NeedsInputItem[], asked?: Array<{ field: string; guess: string; confidence: number }>, from?: StageResult): Promise<StageResult> => {
      const again = await consult(questions, asked);
      if (again) return again;
      if (rounds >= caps.max_rounds) {
        const open = questions.map((q) => q.question).join("; ");
        return { ...(from ?? {}), outcome: "escalated", needsInput: undefined, detail: { ...from?.detail, reason: `triage still needs answers after ${rounds} rounds of questions: ${open}`, escalation: "other" } };
      }
      const kept = questions.slice(0, caps.max_questions);
      return {
        ...(from ?? {}),
        outcome: "needs_input",
        needsInput: kept,
        detail: { ...(from?.detail ?? { summary: `${questions.length} signal${questions.length === 1 ? " is" : "s are"} under the confidence bar: ${asked?.map((a) => a.field).join(", ")}` }), askedBy: "triage", questionsBy: asked ? "machine" : "agent", ...(asked ? { asked: asked.slice(0, caps.max_questions) } : {}), ...(council.settled.length > 0 ? { settledByCouncil: council.settled } : {}) },
      };
    };
    /** The council reads every open question first, before the cap and before the person. What it settles at or over the bar becomes answers
     *  and the entry runs again (null); a council that fails, or settles nothing, leaves every question to the person. */
    const consult = async (questions: NeedsInputItem[], asked?: Array<{ field: string; guess: string; confidence: number }>): Promise<StageResult | null> => {
      const councilCaps = caps.council ?? FACTORY_DEFAULTS.triage.council;
      if (council.ran || !deps.council || !councilCaps.enabled) return null;
      // A stranger's card is not read by the council: its questions are the person's.
      if (trustOf(task) === "untrusted") {
        council.ran = true;
        await context.note?.("this card is untrusted, so the question council did not run; every question goes to you").catch(() => {});
        return null;
      }
      const open = questions
        .map((q, i) => ({ id: `q${i + 1}`, question: q.question, recommended: q.recommended, field: asked?.[i]?.field ?? null, guess: asked?.[i]?.guess ?? null, confidence: asked?.[i]?.confidence ?? null }))
        .filter((q) => q.field === null || COUNCIL_FIELDS.has(q.field))
        .slice(0, MAX_COUNCIL_QUESTIONS);
      if (open.length === 0) return null;
      council.ran = true;
      const failed = async (why: string): Promise<null> => {
        log(`question council for task ${task.id}: ${why}`);
        await context.note?.(`the question council gave no answer (${why}); every question goes to you`).catch(() => {});
        return null;
      };
      let ran: StageResult;
      try {
        ran = await deps.council({ ...context, runId: `${context.runId}-questions`, started: undefined, resume: undefined, engine: undefined }, { questions: open, card: { title: task.title, description: task.description }, answers: answersOf(context.approvals) });
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
      const parsed = QuestionCouncilAnswer.safeParse({ answers: ran.detail?.answers });
      if (ran.outcome !== "pass" || !parsed.success) return failed(ran.outcome !== "pass" ? String(ran.detail?.error ?? ran.detail?.reason ?? ran.outcome).slice(0, 200) : "its answer was not valid");
      const settled: Settled[] = open.flatMap((q) => {
        const given = parsed.data.answers.find((a) => a.id === q.id);
        if (!given || given.answer === null || given.answer.trim() === "") return [];
        // A machine question has its field's own bar (the repo's per-question bar first); the agent's questions have the council's.
        const own = q.field === null ? undefined : (repo?.decisions?.triage_signals?.[QUESTION_OF[q.field]!]?.proceed ?? caps.confidence[q.field as keyof typeof caps.confidence]);
        return given.confidence >= (own ?? councilCaps.bar) ? [{ question: q.question.slice(0, MAX_ANSWER_CHARS), answer: given.answer.slice(0, MAX_ANSWER_CHARS), confidence: given.confidence, evidence: given.evidence, ...(q.field === null ? {} : { field: q.field }) }] : [];
      });
      if (settled.length === 0) return null;
      council.settled.push(...settled);
      // The machine's questions the council left open: if the re-run's classifier gives no reading, these are still the person's.
      const done = new Set(settled.map((s) => s.question));
      council.carry = questions.flatMap((q, i) => (asked?.[i] && !done.has(q.question.slice(0, MAX_ANSWER_CHARS)) ? [{ question: q, asked: asked[i]! }] : []));
      const now = new Date();
      const answered = { id: "question-council", taskId: task.id, kind: "awaiting_answers", requested: { settledByCouncil: settled }, decision: "answered", reason: null, response: { answers: {} }, createdAt: now, decidedAt: now } as unknown as StageContext["approvals"][number];
      const rerun = await entry({ ...raw, approvals: [...raw.approvals, answered] }, council);
      // The entry that ran again has finished the stage: the caller that asked must return this result as it is.
      finished.add(rerun);
      return rerun;
    };
    const enriched = classification ? { ...context, task: { ...task, classification } } : context;
    // A field under its flag bar is the person's to settle, not the agent's: the stage stops and asks, and the signals
    // are read again with the answers. Only a reading taken this time can ask.
    if (classification) {
      const verdicts = triageVerdicts(classification, (repo?.factory ?? FACTORY_DEFAULTS).triage, { ...(repo?.decisions?.triage_signals ? { overrides: repo.decisions.triage_signals } : {}) });
      const asked = askedQuestions(verdicts).sort((x, y) => x.confidence - y.confidence);
      if (asked.length > 0) return await ask(asked.map(({ question, recommended }) => ({ question, recommended })), asked.map(({ field, guess, confidence }) => ({ field, guess, confidence })));
    } else if (council.carry.length > 0) {
      // The council settled some questions and this reading failed: the ones it left open are not dropped.
      return await ask(council.carry.map((c) => c.question), council.carry.map((c) => c.asked));
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
      return agent.outcome === "needs_input" && agent.needsInput?.length ? await ask(agent.needsInput, undefined, agent) : agent;
    };
    let result = await runAgent(enriched);
    if (finished.has(result)) return result;
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
        if (finished.has(result)) return result;
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
  return (context) => entry(context, { ran: false, settled: [], carry: [] });
}
