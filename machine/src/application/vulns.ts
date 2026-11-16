// Vulnerability and dependency triage (RFC 0008, wave 6). Every few hours, for each repository, the open Dependabot and
// code-scanning alerts that no card stands for yet go through the `vuln_triage` pack, and each becomes a board card with a
// deadline. A card keeps its alert's key in `<stateDir>/compliance/vulns/<owner>__<name>.json`; an alert that closed is dropped.
// An alert still open after its deadline is marked overdue: a card's P0 flags are computed when its ticket is assessed and are
// kept nowhere a job can set them, so the mark lives in this state file, on the card's log and in `GET /compliance/vulns`.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { VulnLane, VulnTriageAnswer, type VulnTriageContext } from "@hardness/contracts";
import { z } from "zod";

import { COMPLIANCE_DIR } from "./compliance-drafts.ts";
import { type CodeScanningAlert, type DependabotAlert, type GitHub, messageOf } from "./github.ts";
import type { NewTask } from "./pipeline.ts";
import type { Wiki } from "./wiki.ts";

/** The company's vulnerability policy, a page of the repository's wiki. */
export const POLICY_PATH = "Compliance/Policies/Vulnerability-Management.md";
const POLICY_CAP = 12_000;

const Entry = z.object({
  cardId: z.string(),
  deadline: z.string(),
  lane: VulnLane,
  severity: z.enum(["critical", "high", "medium", "low"]),
  overdue: z.boolean().default(false),
});
type Entry = z.infer<typeof Entry>;
const State = z.object({ schema: z.literal(1), alerts: z.record(z.string(), Entry) });
type State = z.infer<typeof State>;

/** One row of `GET /compliance/vulns`. */
export interface VulnRow {
  repo: string;
  key: string;
  severity: Entry["severity"];
  lane: Entry["lane"];
  deadline: string;
  cardId: string;
  overdue: boolean;
}

/** An alert of either source, in the pack's shape. */
type Alert = { key: string; context: VulnTriageContext["alert"] };

const cap = (value: string, max: number): string => value.slice(0, max);

const fromDependabot = (a: DependabotAlert): Alert => ({
  key: `dependabot:${a.number}`,
  context: {
    source: "dependabot",
    number: a.number,
    severity: a.severity,
    title: cap(a.summary, 500),
    url: a.url,
    createdAt: a.createdAt,
    package: cap(a.package, 200),
    ecosystem: cap(a.ecosystem, 50),
    manifestPath: cap(a.manifestPath, 300),
    vulnerableRange: cap(a.vulnerableRange, 200),
    patchedVersion: a.patchedVersion === null ? null : cap(a.patchedVersion, 100),
    ghsa: cap(a.ghsa, 50),
    cve: a.cve === null ? null : cap(a.cve, 50),
    rule: null,
    tool: null,
    path: null,
  },
});

const fromScanning = (a: CodeScanningAlert): Alert => ({
  key: `code_scanning:${a.number}`,
  context: {
    source: "code_scanning",
    number: a.number,
    severity: a.severity,
    title: cap(a.rule, 500),
    url: a.url,
    createdAt: a.createdAt,
    package: null,
    ecosystem: null,
    manifestPath: null,
    vulnerableRange: null,
    patchedVersion: null,
    ghsa: null,
    cve: null,
    rule: cap(a.rule, 200),
    tool: cap(a.tool, 100),
    path: cap(a.path, 300),
  },
});

const LANE_NOTE: Record<Entry["lane"], string> = {
  fast: "a small bump the fast lane can take",
  full: "the usual plan and review",
  hold: "it waits for a person to decide before any work starts",
};

export interface VulnsDeps {
  github: Pick<GitHub, "dependabotAlerts" | "codeScanningAlerts">;
  wiki: Pick<Wiki, "readPages">;
  /** The one run of the `vuln_triage` pack; its answer is validated here. */
  triage(context: VulnTriageContext): Promise<unknown>;
  pipeline: { createTask(input: NewTask): Promise<{ id: string }>; record(id: string, kind: string, payload: Record<string, unknown>): Promise<void> };
  /** The `owner/name` of every repository the machine knows. */
  repos(): Promise<string[]>;
  /** The checkout of a repository, or null when the machine has none. */
  repoPathOf(slug: string): Promise<string | null>;
  stateDir: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export class Vulns {
  private ticking: Promise<void> | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: VulnsDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
    this.now = deps.now ?? (() => new Date());
  }

  /** One pass over every repository. A pass already running is joined, not doubled. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Every alert a card stands for, across the repositories the machine knows. */
  async list(): Promise<VulnRow[]> {
    const rows: VulnRow[] = [];
    for (const repo of await this.deps.repos()) {
      const { alerts } = await this.load(repo);
      for (const [key, e] of Object.entries(alerts)) rows.push({ repo, key, severity: e.severity, lane: e.lane, deadline: e.deadline, cardId: e.cardId, overdue: e.overdue });
    }
    return rows;
  }

  private async pass(): Promise<void> {
    for (const repo of await this.deps.repos()) {
      try {
        await this.repoPass(repo);
      } catch (error) {
        this.log(`compliance vulns: ${repo}: ${messageOf(error)}`);
      }
    }
  }

  private async repoPass(repo: string): Promise<void> {
    const [dependabot, scanning] = [await this.deps.github.dependabotAlerts(repo), await this.deps.github.codeScanningAlerts(repo)];
    if (dependabot === "unknown" || scanning === "unknown") {
      this.log(`compliance vulns: ${repo}: the token cannot read ${dependabot === "unknown" ? "Dependabot" : "code-scanning"} alerts, skipped`);
      return;
    }
    const open = [...dependabot.map(fromDependabot), ...scanning.map(fromScanning)];
    const state = await this.load(repo);
    const openKeys = new Set(open.map((a) => a.key));
    let changed = false;
    for (const key of Object.keys(state.alerts)) {
      if (!openKeys.has(key)) {
        delete state.alerts[key];
        changed = true;
      }
    }
    const today = this.now().toISOString().slice(0, 10);
    const repoPath = open.some((a) => !(a.key in state.alerts)) ? await this.deps.repoPathOf(repo) : null;
    for (const alert of open) {
      if (alert.key in state.alerts) continue;
      try {
        if (!repoPath) throw new Error("the machine has no checkout of the repository");
        state.alerts[alert.key] = await this.cardFor(repo, repoPath, alert, today);
        changed = true;
        await this.save(repo, state);
      } catch (error) {
        this.log(`compliance vulns: ${repo} ${alert.key}: ${messageOf(error)}`);
      }
    }
    for (const [key, entry] of Object.entries(state.alerts)) {
      if (entry.overdue || today <= entry.deadline) continue;
      entry.overdue = true;
      changed = true;
      await this.deps.pipeline.record(entry.cardId, "compliance.deadline", { key, deadline: entry.deadline, repo }).catch((error: unknown) => this.log(`compliance vulns: ${repo} ${key}: ${messageOf(error)}`));
    }
    if (changed) await this.save(repo, state);
  }

  /** Triage one alert and make its card. */
  private async cardFor(repo: string, repoPath: string, alert: Alert, today: string): Promise<Entry> {
    const answer = VulnTriageAnswer.parse(await this.deps.triage({ repo, alert: alert.context, policy: await this.policy(repo), today }));
    const a = alert.context;
    const task = await this.deps.pipeline.createTask({
      title: answer.title,
      description: [
        answer.goal,
        "",
        `Security alert: ${a.url}`,
        `Severity: ${answer.severity}`,
        `Deadline: ${answer.deadline}`,
        `Lane: ${answer.lane}, ${LANE_NOTE[answer.lane]}.`,
        `Why: ${answer.reason}`,
      ].join("\n"),
      criteria: answer.acceptance_criteria,
      repoPath,
      // A `security` label on the source knocks the card's priority out to P0 when triage reads its signals: only a critical alert earns it.
      source: { kind: "github", repo, number: a.number, url: a.url, labels: answer.severity === "critical" ? ["security"] : [] },
      originMachine: "automation",
      hints: { kind: "security", urgency: answer.severity },
    });
    return { cardId: task.id, deadline: answer.deadline, lane: answer.lane, severity: answer.severity, overdue: false };
  }

  /** The policy page, or null when the wiki has none or cannot be read. */
  private async policy(repo: string): Promise<VulnTriageContext["policy"]> {
    try {
      const page = (await this.deps.wiki.readPages(repo, POLICY_PATH)).find((p) => p.path === POLICY_PATH);
      return page ? { path: page.path, text: cap(page.text, POLICY_CAP) } : null;
    } catch {
      return null;
    }
  }

  private file(repo: string): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "vulns", `${repo.replace("/", "__")}.json`);
  }

  /** A damaged or missing file is an empty state: each open alert is triaged again. */
  private async load(repo: string): Promise<State> {
    try {
      const parsed = State.safeParse(JSON.parse(await readFile(this.file(repo), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // No file, or not JSON.
    }
    return { schema: 1, alerts: {} };
  }

  private async save(repo: string, state: State): Promise<void> {
    const file = this.file(repo);
    await mkdir(join(this.deps.stateDir, COMPLIANCE_DIR, "vulns"), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
  }
}
