// Jira's side of the link, mirrored onto the task every few minutes: status, priority, due date
// and issue type, so the board shows what Jira says without asking it, plus the site's timezone
// (read once from `/myself`), which says when a due date's day ends. When the issue reaches a
// Done-category status (or Cancelled / Won't Do) while the task is still open, the task gets a
// `jira.moved` event: someone decided in Jira, and you decide what the ticket does. A link
// left blocked by JiraSync is tried again on each pass while the issue is reachable, through
// the `retryBlocked` hook (JiraSync.retry), which clears the mark when the move lands. Like
// GitHubPulls it runs on a timer, never throws, and backs off a rate limit. It also warns, once
// a day inside the last two weeks, that the token named by `MACHINE_JIRA_TOKEN_EXPIRES` is about to go.
import type { JiraLink } from "@hardness/contracts";

import { jiraOf } from "../domain/jira-link.ts";
import type { TaskRow } from "../domain/task.ts";
import { type Jira, JiraAuthError, JiraError, messageOf } from "./jira.ts";
import { TokenExpiry } from "./jira-tasks.ts";

export interface JiraWatchOptions {
  pipeline: {
    list(): Promise<TaskRow[]>;
    record(id: string, kind: string, payload: Record<string, unknown>): Promise<void>;
    setJira(id: string, link: JiraLink | null): Promise<TaskRow>;
  };
  jira: Jira;
  intervalMs: number;
  /** Told about a task whose link changed in something the board shows. */
  publish?: (task: TaskRow) => void;
  /** Tries the declared transition a blocked link still waits for; JiraSync.retry in the machine. */
  retryBlocked?: (task: TaskRow) => Promise<void>;
  expiry?: TokenExpiry;
  now?: () => Date;
  warn?: (message: string) => void;
}

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
/** Warn this long before the token's configured expiry, once a day. */
export const EXPIRY_WARNING_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;

/** A status that ends the issue on Jira's side without the task closing. */
export function endedInJira(status: string | null, categoryKey: string | null): boolean {
  if (categoryKey === "done") return true;
  return /^(cancell?ed|won'?t do|wont do)$/i.test((status ?? "").trim());
}

export class JiraWatch {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling: Promise<void> | null = null;
  private warnedAuth = false;
  private lastExpiryWarning: number | null = null;
  /** The site's timezone from `/myself`, read once; undefined until asked, null when Jira left it out. */
  private timeZone: string | null | undefined;
  /** How long until the next poll: the interval, or the backoff after a rate limit. */
  nextDelayMs: number;
  private readonly expiry: TokenExpiry;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  constructor(private readonly options: JiraWatchOptions) {
    this.nextDelayMs = options.intervalMs;
    this.expiry = options.expiry ?? new TokenExpiry();
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Polls now, then again after each poll's delay. Never throws. */
  start(): void {
    if (this.timer || this.stopped) return;
    const poll = () => {
      void this.pollOnce()
        .catch((error: unknown) => this.warn(`jira watch: poll failed: ${messageOf(error)}`))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(poll, this.nextDelayMs);
          this.timer.unref();
        });
    };
    poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass over the open linked tasks; a pass already running is shared. */
  pollOnce(): Promise<void> {
    if (!this.polling) {
      this.polling = this.poll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  private async poll(): Promise<void> {
    this.nextDelayMs = this.options.intervalMs;
    this.warnExpiry();
    const tasks = (await this.options.pipeline.list()).filter((t) => t.state !== "closed" && jiraOf(t));
    if (tasks.length > 0 && this.timeZone === undefined) {
      try {
        this.timeZone = (await this.options.jira.me()).timeZone;
      } catch (error) {
        if (error instanceof JiraAuthError) {
          this.expiry.note(error);
          if (!this.warnedAuth) this.warn(`jira watch: ${error.message}`);
          this.warnedAuth = true;
          return;
        }
        this.warn(`jira watch: could not read the site's timezone: ${messageOf(error)}`);
      }
    }
    for (const task of tasks) {
      const link = jiraOf(task)!;
      try {
        const issue = await this.options.jira.issue(link.key);
        this.warnedAuth = false;
        const timeZone = this.timeZone ?? link.timeZone ?? null;
        const next: JiraLink = { ...link, status: issue.status, priority: issue.priority, dueAt: issue.dueAt, issueType: issue.issueType, syncedAt: this.now().toISOString(), timeZone };
        const changed = next.status !== link.status || next.priority !== link.priority || next.dueAt !== link.dueAt || next.issueType !== link.issueType || timeZone !== (link.timeZone ?? null);
        let updated = await this.options.pipeline.setJira(task.id, next);
        if (changed || !task.jira) this.options.publish?.(updated);
        if (endedInJira(issue.status, issue.statusCategory) && !endedInJira(link.status, null) && next.status !== link.status) {
          await this.options.pipeline.record(task.id, "jira.moved", { status: issue.status, key: link.key });
        }
        // The issue answers again: a transition JiraSync could not make last time may go through now.
        if (next.blocked && this.options.retryBlocked) {
          await this.options.retryBlocked(updated);
          updated = (await this.options.pipeline.list()).find((t) => t.id === task.id) ?? updated;
          if (!jiraOf(updated)?.blocked) this.options.publish?.(updated);
        }
      } catch (error) {
        if (error instanceof JiraAuthError) {
          this.expiry.note(error);
          if (!this.warnedAuth) this.warn(`jira watch: ${error.message}`);
          this.warnedAuth = true;
          return;
        }
        if (error instanceof JiraError && error.status === 429) {
          this.nextDelayMs = RATE_LIMIT_BACKOFF_MS;
          this.warn(`jira watch: rate limited; next poll in ${RATE_LIMIT_BACKOFF_MS / 60_000} minutes`);
          return;
        }
        this.warn(`jira watch: ${link.key} (task ${task.id.slice(0, 8)}): ${messageOf(error)}`);
      }
    }
  }

  /** Once a day inside the last two weeks of the token (`MACHINE_JIRA_TOKEN_EXPIRES`, or the date a 401 named): make a new one. */
  private warnExpiry(): void {
    const at = this.expiry.at ? Date.parse(this.expiry.at) : NaN;
    if (Number.isNaN(at)) return;
    const now = this.now().getTime();
    if (at - now > EXPIRY_WARNING_MS) return;
    if (this.lastExpiryWarning !== null && now - this.lastExpiryWarning < DAY_MS) return;
    this.lastExpiryWarning = now;
    const days = Math.max(0, Math.ceil((at - now) / DAY_MS));
    this.warn(`jira: the API token ${days === 0 ? "has expired" : `expires in ${days} day(s)`} (${this.expiry.at}); make a new one at id.atlassian.com and set MACHINE_JIRA_TOKEN (and MACHINE_JIRA_TOKEN_EXPIRES)`);
  }
}
