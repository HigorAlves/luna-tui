// The one way a decision pack is put to any model that is not Jev: the state, then the questions
// in plain words, then the rule that the answer is the JSON the schema asks for, with a confidence
// per question. Jev gets the questions on its own wire (runtimes/jev/questions.ts); every other
// runtime renders this text and asks for structured output on `answerJsonSchema(pack)`.
import type { Question, QuestionSet, StageInput } from "@hardness/contracts";

/** What a decision reads: the issue as intake sent it. */
export type DecisionState = {
  title: string;
  description: string;
  labels?: string[];
  source?: string;
};

/** The issue intake sent, else the task's own title and description. */
export function stateOf(input: StageInput): DecisionState {
  const { title, description, labels, source } = input.context.issue ?? { title: input.task.title, description: input.task.description };
  return { title, description, ...(labels && { labels }), ...(source && { source }) };
}

function renderQuestion(name: string, q: Question): string {
  switch (q.type) {
    case "choice":
      return [`## ${name} (choice)`, q.instructions ?? "", ...Object.entries(q.criteria).map(([label, means]) => `- ${label}: ${means}`), "Answer `choice` with one label and `confidence` in [0, 1]."].filter(Boolean).join("\n");
    case "yesno":
      return [`## ${name} (yes or no)`, q.instructions, "Answer `value` true or false and `p`, the probability of yes, in [0, 1]."].join("\n");
    case "score": {
      const levels = Object.entries(q.rubric).map(([label, means], i) => `- ${i} ${label}: ${means}`);
      return [`## ${name} (score)`, q.instructions, ...levels, `Answer \`score\` from 0 to ${levels.length - 1} (fractions between levels) and \`confidence\` in [0, 1].`].join("\n");
    }
  }
}

export function renderDecision(questions: QuestionSet, state: DecisionState): string {
  const extras = [state.labels?.length ? `Labels: ${state.labels.join(", ")}` : "", state.source ? `Source: ${state.source}` : ""].filter(Boolean);
  return [
    "# State",
    `**${state.title}**`,
    state.description,
    ...extras,
    "",
    "# Questions",
    ...Object.entries(questions).map(([name, q]) => renderQuestion(name, q)),
    "",
    "# Answer",
    "Answer only with the JSON object the schema asks for: one key per question, exactly the fields named above. A confidence is how sure you are of that one answer, calibrated: 0.5 is a coin toss, 0.95 means you would be surprised to be wrong. Nothing else.",
  ].join("\n");
}

const two = (n: number) => n.toFixed(2);

/** One transcript line per answer, then the questions whose confidence is under `bar`. */
export function decisionSummary(questions: QuestionSet, answer: Record<string, unknown>, bar: number): string {
  const parts: string[] = [];
  const below: string[] = [];
  for (const [name, q] of Object.entries(questions)) {
    const a = answer[name] as Record<string, number | string | boolean> | undefined;
    if (!a) continue;
    if (q.type === "yesno") {
      const p = Number(a.p);
      parts.push(`${name} ${a.value ? "yes" : "no"} (p ${two(p)})`);
      if (Math.max(p, 1 - p) < bar) below.push(name);
    } else {
      const c = Number(a.confidence);
      parts.push(`${name} ${q.type === "choice" ? String(a.choice) : Math.round(Number(a.score) * 100) / 100} (${two(c)})`);
      if (c < bar) below.push(name);
    }
  }
  return below.length ? `${parts.join(" · ")} · below ${bar}: ${below.join(", ")}` : parts.join(" · ");
}
