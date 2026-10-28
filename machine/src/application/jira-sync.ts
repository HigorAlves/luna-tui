// Jira follows the board. On each pipeline event, for a task linked to an issue whose repo's
// luna.yaml declares what that task state means in Jira, the machine moves the issue: it reads
// the transitions available now, performs the one whose target status matches the declared
// name (case does not matter), with the declared fields filled in. Already there: nothing. No
// way there from where the issue is: a `jira.blocked` event and a mark on the link, never a
// retry loop and never a fake status. Comments go out at the moments ThreadReplies already
// writes about (`milestones`), at every gate too (`gates`), or never (`none`). Reactions for
// one task run one after another, in the order the events came: two quick transitions read
// Jira in turn, so the later one lands last. A stepping stone the task has already left is
// skipped when the newer status is reachable directly. Nothing here ever throws into the
// pipeline; a failure is a warning and, where it fits, a blocked mark.
import { WAITING_ON_USER, type JiraLink, type TaskState } from "@hardness/contracts";

import { jiraOf } from "../domain/jira-link.ts";
import type { JiraPolicy, Policy } from "../domain/policy.ts";
import type { ArtifactRow, EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { type Jira, messageOf } from "./jira.ts";

export interface JiraSyncOptions {
  pipeline: {
    get(id: string): Promise<TaskRow>;
    events(id: string): Promise<EventRow[]>;
    stageRuns(id: string): Promise<StageRunRow[]>;
    artifacts(id: string): Promise<ArtifactRow[]>;
    record(id: string, kind: string, payload: Record<string, unknown>): Promise<void>;
    setJira(id: string, link: JiraLink | null): Promise<TaskRow>;
    policyFor(repoPath: string | null): Promise<Policy>;
  };
  jira: Jira;
  /** False when Jira is not configured: every event is ignored. */
  enabled: boolean;
  /** Where the board is reached, for `{board_url}` in declared fields; null leaves it empty. */
  boardUrl?: string | null;
  now?: () => Date;
}

/** What a gate asks of you, as the comment says it. */
const ASKS: Partial<Record<TaskState, string>> = {
  awaiting_setup: "approve the proposed luna.yaml",
  awaiting_answers: "answer triage's questions",
  awaiting_approval: "approve the plan",
  awaiting_test_check: "check the tests",
  awaiting_ship: "choose how to ship",
  reviewing_memory: "review the memory proposal",
};

const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export class JiraSync {
  private readonly pending = new Set<Promise<void>>();
  /** The tail of each task's chain of reactions; the next one waits for it. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(private readonly options: JiraSyncOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Reacts to one pipeline event. Never throws; failures are logged. Resolves once done. */
  handle(event: EventRow): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    const previous = this.chains.get(event.taskId) ?? Promise.resolve();
    const run = previous.then(() => this.react(event)).catch((error: unknown) => console.warn(`jira sync for task ${event.taskId} failed: ${messageOf(error)}`));
    this.chains.set(event.taskId, run);
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      if (this.chains.get(event.taskId) === run) this.chains.delete(event.taskId);
    });
    return run;
  }

  /** Resolves once every reaction in flight has finished (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async react(event: EventRow): Promise<void> {
    if (event.kind !== "transition" && event.kind !== "stage.finished") return;
    const task = await this.options.pipeline.get(event.taskId);
    const link = jiraOf(task);
    if (!link) return;
    const policy = (await this.options.pipeline.policyFor(task.repoPath)).jira;
    if (!policy) return;

    if (event.kind === "stage.finished") {
      const detail = event.payload.detail as { prUrl?: unknown } | undefined;
      const url = typeof detail?.prUrl === "string" ? detail.prUrl : null;
      if (!url || policy.comments === "none") return;
      // The record, not memory, says whether this url was announced: a restart does not repeat it.
      const events = await this.options.pipeline.events(task.id);
      if (events.some((e) => e.kind === "jira.commented" && e.payload.url === url)) return;
      if (await this.comment(link, `PR opened: ${url}`)) await this.options.pipeline.record(task.id, "jira.commented", { url });
      return;
    }

    const to = event.payload.to as TaskState;
    const from = event.payload.from as TaskState;
    if (policy.comments !== "none") {
      // An intake import was already told "Picked up" by JiraIntake when the ticket was made.
      if (from === "draft" && event.payload.event === "start" && task.source?.kind !== "jira") await this.comment(link, `Picked up as task #${task.id.slice(0, 8)} on the Luna board.`);
      else if (to === "closed") await this.comment(link, await this.closing(task));
      else if (policy.comments === "gates" && WAITING_ON_USER.has(to) && to !== from) {
        await this.comment(link, to === "escalated" ? `Escalated: ${String(event.payload.reason ?? "see the board")}.` : `Needs you: ${ASKS[to] ?? to}.`);
      }
    }
    const wanted = policy.on[to];
    if (wanted) await this.move(task, link, policy, to, wanted);
  }

  /** Moves the issue to `wanted`, or marks the link blocked saying why. */
  private async move(task: TaskRow, link: JiraLink, policy: JiraPolicy, state: TaskState, wanted: string): Promise<void> {
    const { jira, pipeline } = this.options;
    let current: string | null = link.status;
    try {
      current = (await jira.issue(link.key)).status;
      if (same(current, wanted)) {
        if (link.blocked || !same(link.status, wanted)) await pipeline.setJira(task.id, { ...link, status: current, syncedAt: this.now().toISOString(), blocked: null });
        return;
      }
      const transitions = await jira.transitions(link.key);
      const match = transitions.find((t) => same(t.to.name, wanted));
      if (!match) return this.blocked(task, link, wanted, current, `no transition to "${wanted}" from "${current ?? "unknown"}"`);
      // The task may have moved on while this reaction waited its turn: when its state now wants
      // another status that the issue can reach directly, this one is a stepping stone nobody needs.
      const latest = await pipeline.get(task.id);
      const newer = policy.on[latest.state];
      if (latest.state !== state && newer && !same(newer, wanted) && transitions.some((t) => same(t.to.name, newer))) return;
      const fields = await this.fields(task, policy.fields[state]);
      await jira.transition(link.key, match.id, fields);
      await pipeline.record(task.id, "jira.transitioned", { from: current, to: match.to.name, ...(fields ? { fields: Object.keys(fields) } : {}) });
      await pipeline.setJira(task.id, { ...link, status: match.to.name, syncedAt: this.now().toISOString(), blocked: null });
    } catch (error) {
      await this.blocked(task, link, wanted, current, messageOf(error));
    }
  }

  private async blocked(task: TaskRow, link: JiraLink, wanted: string, current: string | null, why: string): Promise<void> {
    const at = this.now().toISOString();
    await this.options.pipeline.record(task.id, "jira.blocked", { wanted, current, why });
    await this.options.pipeline.setJira(task.id, { ...link, status: current ?? link.status, blocked: { wanted, current, why, at } });
  }

  /** The declared fields for a state with their placeholders filled; undefined when none. */
  private async fields(task: TaskRow, declared: Record<string, string> | undefined): Promise<Record<string, unknown> | undefined> {
    if (!declared || Object.keys(declared).length === 0) return undefined;
    const prUrl = (await this.prUrl(task.id)) ?? "";
    const values: Record<string, string> = {
      "{pr_url}": prUrl,
      "{task_id}": task.id,
      "{branch}": task.branch ?? "",
      "{board_url}": this.options.boardUrl ?? "",
    };
    return Object.fromEntries(
      Object.entries(declared).map(([field, template]) => [field, Object.entries(values).reduce((text, [key, value]) => text.split(key).join(value), template)]),
    );
  }

  /** The PR the task opened, from the latest stage that reported one. */
  private async prUrl(taskId: string): Promise<string | null> {
    const events = await this.options.pipeline.events(taskId);
    const finished = events.findLast((e) => e.kind === "stage.finished" && typeof (e.payload.detail as { prUrl?: unknown } | undefined)?.prUrl === "string");
    return finished ? ((finished.payload.detail as { prUrl: string }).prUrl ?? null) : null;
  }

  /** The closing comment: the PR, the criteria with verifying's verdicts, the evidence left. */
  private async closing(task: TaskRow): Promise<string> {
    const lines = [`Closed on the Luna board as task #${task.id.slice(0, 8)}.`];
    const prUrl = await this.prUrl(task.id);
    if (prUrl) lines.push("", `PR: ${prUrl}`);
    if (task.criteria.length > 0) lines.push("", "Criteria:", ...task.criteria.map((c) => `- ${c}`));
    const runs = await this.options.pipeline.stageRuns(task.id);
    const verifying = runs.findLast((r) => r.stage === "verifying" && r.cases && r.cases.length > 0);
    if (verifying?.cases) {
      const passed = verifying.cases.filter((c) => c.ok).length;
      lines.push("", `Verifying: ${passed} of ${verifying.cases.length} cases passed`, ...verifying.cases.map((c) => `- ${c.ok ? "pass" : "fail"}: ${c.title}`));
    }
    const artifacts = await this.options.pipeline.artifacts(task.id);
    const evidence = artifacts.filter((a) => a.kind === "screenshot" || a.kind === "video" || a.kind === "qa-manifest" || a.kind === "report" || a.kind === "har").map((a) => a.label || a.path);
    if (evidence.length > 0) lines.push("", "Evidence:", ...evidence.map((e) => `- ${e}`));
    return lines.join("\n");
  }

  /** Posts a comment; false (and a warning) when Jira refused. */
  private async comment(link: JiraLink, text: string): Promise<boolean> {
    try {
      await this.options.jira.comment(link.key, text);
      return true;
    } catch (error) {
      console.warn(`jira comment on ${link.key} failed: ${messageOf(error)}`);
      return false;
    }
  }
}
