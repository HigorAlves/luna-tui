// The ticket's actions beyond the gate's main buttons: ask before approving or stopping, retry
// with guidance, reject the release, the edits, Jira, findings, evidence feedback, duplicates,
// the worktree, setting a repo up, opening the issue and the PR, and watching the running stage.
// Buttons go in the inspector's More menu (`more`), handlers in `ACTIONS`; the dialogs are in
// dialogs-edit.js and the rules (when each applies) in actions-rules.js.
import * as herdr from "herdr";
import { exec, pickFolder, run } from "herdr";

import {
  atMemoryReview,
  atRelease,
  approveWords,
  canAddFinding,
  canCorrectRecord,
  canDismissFinding,
  canEditCases,
  canEditPlan,
  canEditPlanFully,
  canEditTicket,
  canGiveFeedback,
  canLinkJira,
  canMerge,
  canRemoveWorktree,
  canSetRepo,
  canUnlinkJira,
  canUnmerge,
  canWatch,
  casesOf,
  detailOf,
  isEscalated,
  issueLink,
  latestApproval,
  openFindings,
  planFields,
  prLink,
  recordValue,
  RECORD_FIELDS,
  shortId,
  watchTab,
} from "./actions-rules.js";
import "./dialogs-edit.js";
import { actionsFor, ended, plainTitle } from "./model.js";
import { ACTIONS, COMMANDS, more, page, palette } from "./registry.js";

const enc = encodeURIComponent;
const say = (app, e) => app.say(e?.message ?? String(e), "error");

// ---- Jira: is it configured on the machine? Read once, kept in app.state("jira") ----

const JIRA_RETRY_MS = 30000;

/** Starts the read when it has not been made (or failed a while ago); `configured` reads false until it lands. */
export function ensureJira(app) {
  const s = app.state?.("jira");
  if (!s || s.loading || (s.at && (s.loaded || Date.now() - s.at < JIRA_RETRY_MS))) return s;
  s.loading = true;
  Promise.resolve()
    .then(() => app.machine.get("/jira/status"))
    .then((r) => {
      s.configured = Boolean(r?.configured);
      s.site = r?.site ?? null;
      s.loaded = true;
    })
    .catch((e) => {
      // A machine without Jira has no route: 404 says "not configured", which is an answer.
      s.configured = false;
      s.loaded = e?.status === 404;
    })
    .finally(() => {
      s.loading = false;
      s.at = Date.now();
      s.fresh = true;
    });
  return s;
}

// ---- decisions ----

const subtitle = (task) => plainTitle(task);

// Ask once before approving (the TUI's `a`); an escalated card retries with guidance instead.
ACTIONS.approve = (app, task) => {
  if (app.busy?.has(task.id)) return;
  if (isEscalated(task)) return app.dialog({ kind: "guidance", taskId: task.id, subtitle: subtitle(task) }, 330);
  const words = approveWords(task);
  const label = actionsFor(task).find((a) => a.id === "approve")?.label ?? "Approve";
  return app.dialog({ kind: "approve_ask", taskId: task.id, title: words.title, body: words.body, label, subtitle: subtitle(task) }, 250);
};

// Ask before stopping a running stage.
ACTIONS.abort = (app, task) =>
  app.confirm({
    title: "Stop the running stage?",
    body: "The stage is aborted and the ticket waits for you. Work it did not commit may be lost.",
    label: "Stop",
    danger: true,
    subtitle: subtitle(task),
    call: { method: "POST", path: `/tasks/${enc(task.id)}/abort`, body: {} },
  });

ACTIONS.reject_release = (app, task) => app.dialog({ kind: "reject_release", taskId: task.id, subtitle: subtitle(task) }, 340);

ACTIONS.memory_skip_rules = (app, task) =>
  app.dialog({
    kind: "approve_ask",
    taskId: task.id,
    title: "Approve, skipping the rules?",
    body: "The memory review is approved, but its proposed rules are not written to project-context.md.",
    label: "Approve, skip the rules",
    extra: { applyRules: false, reason: "rules skipped" },
    subtitle: subtitle(task),
  }, 250);

// ---- edits ----

ACTIONS.edit_ticket = (app, task) =>
  app.dialog({ kind: "edit_ticket", taskId: task.id, subtitle: subtitle(task), ticketTitle: task.title ?? "", description: task.description ?? "", criteria: task.criteria ?? [] }, 560, 560);

ACTIONS.edit_plan = (app, task) => {
  const detail = detailOf(app, task);
  const gate = latestApproval(detail, "awaiting_approval");
  if (!gate || !canEditPlan(task, detail)) return app.say("The plan can no longer be edited.", "error");
  const full = canEditPlanFully(task, detail);
  return app.dialog({ kind: "edit_plan", taskId: task.id, subtitle: subtitle(task), plan: planFields(gate.requested), full }, full ? 700 : 520, 580);
};

ACTIONS.edit_cases = (app, task) => {
  const detail = detailOf(app, task);
  if (!canEditCases(task, detail)) return app.say("The cases can only change while they wait for your check.", "error");
  return app.dialog({ kind: "edit_cases", taskId: task.id, subtitle: subtitle(task), cases: casesOf(detail) }, 560, 580);
};

ACTIONS.edit_record = (app, task) =>
  app.dialog({ kind: "edit_record", taskId: task.id, subtitle: subtitle(task), current: Object.fromEntries(RECORD_FIELDS.map(([k]) => [k, recordValue(task, k)])) }, 430);

ACTIONS.escalation_reason = (app, task) =>
  app.dialog({ kind: "escalation_reason", taskId: task.id, subtitle: subtitle(task), current: task.gate?.requested?.escalationDecision?.reason ?? task.reason ?? null }, 370);

ACTIONS.set_repo = (app, task, cx) =>
  cx.spawn(async () => {
    let known = [];
    try {
      known = ((await app.machine.get("/repos")) ?? []).map((r) => r.repo).filter(Boolean);
    } catch {
      // the picker still works with the folder chooser
    }
    const repos = [...new Set([...known, ...app.tasks.map((t) => t.repoPath).filter(Boolean)])].sort();
    app.dialog({ kind: "set_repo", taskId: task.id, subtitle: subtitle(task), current: task.repoPath ?? null, repos }, 480);
  });

// ---- Jira ----

ACTIONS.jira_link = (app, task) => app.dialog({ kind: "jira_link", taskId: task.id, subtitle: subtitle(task) }, 480);
ACTIONS.jira_create = (app, task) => app.dialog({ kind: "jira_create", taskId: task.id, subtitle: subtitle(task) }, 330);
ACTIONS.jira_unlink = (app, task) =>
  app.confirm({
    title: "Unlink the Jira issue?",
    body: `${task.jira?.key ?? "The issue"} stays in Jira; only the link is dropped. A ticket that already works on a branch cannot unlink.`,
    label: "Unlink",
    danger: true,
    subtitle: subtitle(task),
    call: { method: "DELETE", path: `/tasks/${enc(task.id)}/jira` },
  });

// ---- findings and evidence ----

ACTIONS.finding_dismiss = (app, task) => {
  const findings = openFindings(detailOf(app, task)).map((f) => ({ id: f.id, title: f.title, severity: f.severity, path: f.path ?? null, line: f.line ?? null }));
  if (!findings.length) return app.say("Verify has no open finding to dismiss.", "error");
  return app.dialog({ kind: "finding_dismiss", taskId: task.id, subtitle: subtitle(task), findings }, Math.min(620, 300 + findings.length * 34));
};
ACTIONS.finding_add = (app, task) => app.dialog({ kind: "finding_add", taskId: task.id, subtitle: subtitle(task) }, 400);
ACTIONS.evidence_useful = (app, task) => app.dialog({ kind: "evidence_feedback", taskId: task.id, subtitle: subtitle(task), useful: true }, 310);
ACTIONS.evidence_not_useful = (app, task) => app.dialog({ kind: "evidence_feedback", taskId: task.id, subtitle: subtitle(task), useful: false }, 310);

// ---- duplicates and the worktree ----

ACTIONS.merge_into = (app, task) => {
  const candidates = app.tasks
    .filter((x) => x.id !== task.id)
    .sort((a, b) => Number(ended(a)) - Number(ended(b)))
    .map((x) => ({ id: x.id, title: plainTitle(x), state: x.state }));
  return app.dialog({ kind: "merge_into", taskId: task.id, subtitle: subtitle(task), candidates }, 460);
};
ACTIONS.unmerge = (app, task) =>
  app.confirm({
    title: "Bring the duplicate back?",
    body: "It comes back as a new card, no longer merged into the other ticket.",
    label: "Bring it back",
    subtitle: subtitle(task),
    call: { method: "POST", path: `/tasks/${enc(task.id)}/unmerge`, body: {} },
  });
ACTIONS.remove_worktree = (app, task) => app.dialog({ kind: "remove_worktree", taskId: task.id, subtitle: subtitle(task) }, 280);

// ---- repositories ----

/** Asks the machine for a setup task on a checkout; the card is selected. */
function setUp(app, repoPath, cx) {
  const path = repoPath.replace(/\/+$/, "");
  app.run(cx, `setup:${path}`, "Setting the repository up: its luna.yaml waits for you", async () => {
    const task = await app.machine.post("/repos/setup", { repoPath: path });
    if (task?.id) {
      app.go?.("board", cx);
      app.select(task.id, cx);
    }
    return task;
  });
}

const pickAndSetUp = (app, cx) =>
  cx.spawn(async (cx) => {
    const folder = await pickFolder({ prompt: "Set this repository up" });
    if (folder) setUp(app, folder, cx);
  });

ACTIONS.setup_repo = (app, _task, cx) => pickAndSetUp(app, cx);
COMMANDS.setup = (app, arg, cx) => (arg?.trim() ? setUp(app, arg.trim(), cx) : pickAndSetUp(app, cx));
palette({ id: "setup-repo", label: "Set a repo up…", hint: "propose its luna.yaml", run: (app, cx) => pickAndSetUp(app, cx) });

// ---- opening ----

ACTIONS.open_issue = (app, task) => {
  const url = issueLink(task);
  return url ? app.openUrl(url) : app.say("This ticket has no linked issue.", "error");
};
ACTIONS.open_pr = (app, task) => {
  const url = prLink(task, detailOf(app, task), app);
  return url ? app.openUrl(url) : app.say("No PR yet.", "error");
};

// ---- watching the running stage ----

// A hidden page that only listens: it keeps each task's latest `stage.started`, as the TUI does for `f`.
page({
  id: "luna-watch",
  label: "Watch",
  icon: "play",
  hidden: true,
  render: () => null,
  onMessage: (app, { event, data }) => {
    const watch = app.state("watch");
    if (event === "stage.started" && data?.taskId) {
      watch[data.taskId] = { label: data.label, cwd: data.cwd, container: data.container };
      return false;
    }
    if (event === "task.closed" && data?.id) delete watch[data.id];
    // Any message after Jira's status landed redraws, so the Jira buttons appear.
    const jira = app.state("jira");
    if (jira.fresh) {
      jira.fresh = false;
      return true;
    }
    return false;
  },
});

/** The task's open watch tab, found by its `#<short id> ` label as the TUI finds it. */
function watchTabId(task) {
  try {
    for (const space of herdr.spaces?.() ?? []) for (const tab of space.tabs ?? []) if (String(tab.name).startsWith(`#${shortId(task.id)} `)) return tab.id;
  } catch {
    // no tab list: open one
  }
  return null;
}

/** The stage the stream last named, else a running container the machine labelled with this task. */
async function stageOf(app, task) {
  const known = app.state("watch")[task.id];
  if (known) return known;
  try {
    const r = await exec("docker", ["ps", "--filter", `label=dev.hardness.task=${task.id}`, "--format", "{{.Names}}"], { timeout: 8000 });
    const container = r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).find(Boolean) : null;
    if (container) return { label: `#${shortId(task.id)} ${plainTitle(task)}`, cwd: task.worktreePath ?? task.repoPath ?? "", container };
  } catch {
    // docker is not there
  }
  return null;
}

ACTIONS.watch = (app, task, cx) =>
  cx.spawn(async (cx) => {
    const open = watchTabId(task);
    if (open) {
      run("tab.select", { id: open });
      return;
    }
    const { tab, error } = watchTab(await stageOf(app, task));
    if (error) app.say(error, "error");
    else run("tab.new", tab);
    cx.notify();
  });

// ---- the buttons: each with the TUI's condition ----

const detail = (task, app) => detailOf(app, task);
const buttons = [
  ["reject_release", "Reject the release", "danger", (task) => atRelease(task)],
  ["memory_skip_rules", "Approve, skip the rules", "plain", (task) => atMemoryReview(task)],
  ["watch", "Watch the stage", "plain", (task) => canWatch(task)],
  ["edit_ticket", "Edit the ticket", "plain", (task) => canEditTicket(task)],
  ["edit_plan", "Edit the plan", "plain", (task, app) => canEditPlan(task, detail(task, app))],
  ["edit_cases", "Edit the test cases", "plain", (task, app) => canEditCases(task, detail(task, app))],
  ["edit_record", "Correct the triage record", "plain", (task) => canCorrectRecord(task)],
  ["escalation_reason", "Correct the escalation reason", "plain", (task) => task.state === "escalated"],
  ["set_repo", "Set the repository", "plain", (task) => canSetRepo(task)],
  ["setup_repo", "Set a repo up…", "plain", (task) => !ended(task) && (task.state === "draft" || !task.repoPath)],
  ["jira_link", "Link a Jira issue", "plain", (task, app) => canLinkJira(task, app)],
  ["jira_create", "Create a Jira issue", "plain", (task, app) => canLinkJira(task, app)],
  ["jira_unlink", "Unlink the Jira issue", "danger", (task, app) => canUnlinkJira(task, app)],
  ["finding_dismiss", "Dismiss a finding", "plain", (task, app) => canDismissFinding(task, detail(task, app))],
  ["finding_add", "Add a finding", "plain", (task, app) => canAddFinding(task, detail(task, app))],
  ["evidence_useful", "Evidence was useful", "plain", (task) => canGiveFeedback(task)],
  ["evidence_not_useful", "Evidence was not useful", "plain", (task) => canGiveFeedback(task)],
  ["merge_into", "Close as a duplicate…", "plain", (task) => canMerge(task)],
  ["unmerge", "Bring it back", "plain", (task) => canUnmerge(task)],
  ["remove_worktree", "Remove the worktree", "danger", (task) => canRemoveWorktree(task)],
  ["open_issue", "Open the issue", "plain", (task) => Boolean(issueLink(task))],
  ["open_pr", "Open the PR", "plain", (task, app) => Boolean(prLink(task, detail(task, app), app))],
];

for (const [id, label, kind, when] of buttons) {
  more({
    id,
    label,
    kind,
    when: (task, app) => {
      if (id.startsWith("jira_")) ensureJira(app);
      return when(task, app);
    },
  });
}

export { buttons };
