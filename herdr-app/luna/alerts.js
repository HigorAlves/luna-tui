// Alerts: a Herdr notification for what the TUI's `notify.rs` raises, each once. A hidden page that
// only listens: every stream message reaches `onMessage` after the board applied it. The first
// message seeds what is already true (tasks, pull requests, Slack items, the link), so nothing
// is announced for what was there when the pane started; only a change after that is news.
//
//   task      into Needs you, Escalated or Paused on a usage limit; Gate overdue; Stage over SLA;
//             Jira (someone moved the linked issue)
//   PR        into Review requested, Changes requested, CI failed or Ready to merge
//   Slack     Reopened, Overdue, and a P0/P1 entering Needs reply or Decide (quiet hours hold all
//             but a P0 back)
//   machine   Machine offline, Machine back
//   budget    an engine passing a share of its ceiling
//
// A click on a toast brings Luna's pane to the front (`luna.focus`).
import { notify } from "herdr";

import { escalationWords, gateQuestion, look } from "./model.js";
import { channelLabel, flat, repoName, span, summaryOf } from "./integrations-model.js";
import { PR_SPLITS, cardLine } from "./model.js";
import { page } from "./registry.js";

const PR_ALERTS = new Set(["review_requested", "changes_requested", "ci_failed", "ready_to_merge"]);
const PR_LABEL = Object.fromEntries(PR_SPLITS);
const NEEDS_ME = { needs_reply: "Needs reply", decide: "Decide" };
const LOOKS = { needs_you: "Needs you", escalated: "Escalated", paused: "Paused on a usage limit" };
const LINK_CHECK_MS = 5000;
const ICON = "mods/luna/icons/hand.svg";

const shortId = (task) => String(task.id ?? "").slice(0, 8);
const where = (task) => (task.repoPath ? `${repoName(task.repoPath)} · ` : "");
const named = (task) => `${where(task)}#${shortId(task)} ${flat(task.title)}`;

/** What a task's clocks and look say, remembered per ticket. */
const taskFacts = (task, now) => ({ look: look(task, now), gate: Boolean(task.sla?.gate?.overdue), stage: Boolean(task.sla?.stage?.overdue) });

/** The notices a task's change is worth, from what was remembered of it (`before`, or undefined when first seen). */
export function taskNotices(before, task, now = Date.now()) {
  const out = [];
  const facts = taskFacts(task, now);
  const title = LOOKS[facts.look];
  if (title && before?.look !== facts.look) {
    const what = facts.look === "needs_you" ? gateQuestion(task) ?? "Waiting on you" : facts.look === "escalated" ? (task.reason ? escalationWords(task.reason) : cardLine(task, now).text) : cardLine(task, now).text;
    out.push({ title, body: `${named(task)}: ${flat(what)}`, level: "warning" });
  }
  if (facts.gate && !before?.gate) {
    const target = task.sla?.gate?.targetSecs;
    out.push({ title: "Gate overdue", body: `${named(task)}: ${flat(cardLine(task, now).text)} waited past ${typeof target === "number" ? span(target) : "its target"}`, level: "warning" });
  }
  if (facts.stage && !before?.stage) {
    const stage = task.sla?.stage?.stage ?? cardLine(task, now).text;
    out.push({ title: "Stage over SLA", body: `${named(task)}: ${flat(String(stage).replaceAll("_", " "))} is past its target`, level: "warning" });
  }
  return { facts, notices: out };
}

/** The notice a PR's move into a split that needs you is worth, or null. */
export function prNotice(oldSplit, pr) {
  if (!PR_ALERTS.has(pr?.split) || oldSplit === pr.split) return null;
  return { title: PR_LABEL[pr.split] ?? pr.split, body: `${pr.repo}#${pr.number} ${flat(pr.title)}`, level: "info" };
}

/** The notice a Slack item is worth (the TUI's `slack_notice`), or null. `old` is `{split, reopenedAt, overdue}` or undefined. */
export function slackNotice(old, item, quiet = false) {
  const body = `${channelLabel(item)} @${flat(item.author?.name)}: ${summaryOf(item)}`;
  const p0 = item.triage?.priority === "P0";
  let n = null;
  if (item.reopenedAt && item.reopenedAt !== old?.reopenedAt) n = { title: "Reopened", body, level: "warning" };
  else if (item.overdue && !old?.overdue) n = { title: "Overdue", body, level: "warning" };
  else if (NEEDS_ME[item.split] && old?.split !== item.split && ["P0", "P1"].includes(item.triage?.priority)) n = { title: NEEDS_ME[item.split], body, level: "warning" };
  return n && quiet && !p0 ? null : n;
}

const slackFacts = (i) => ({ split: i.split, reopenedAt: i.reopenedAt ?? null, overdue: Boolean(i.overdue) });

function seed(app, st, now) {
  st.seeded = true;
  st.tasks = new Map((app.tasks ?? []).map((t) => [t.id, taskFacts(t, now)]));
  st.prs = new Map((app.prs?.inbox?.prs ?? []).map((p) => [`${p.repo}#${p.number}`, p.split]));
  st.link = app.link;
}

function post(n) {
  const base = { title: n.title, body: n.body, level: n.level ?? "info", icon: ICON };
  try {
    notify({ ...base, action: { name: "luna.focus" } });
  } catch {
    try {
      notify(base);
    } catch {
      // no toast host: nothing to do
    }
  }
}

/** Reads one stream message; returns the notices it is worth and updates what is remembered. `app` supplies `tasks`, `prs` and `link`. */
export function scan(app, st, { event, data }, now = Date.now()) {
  if (!app.loaded) return [];
  if (!st.seeded) {
    seed(app, st, now);
    st.slack = null;
    st.events = new Set();
    st.budget = new Set();
    return [];
  }
  const out = [];
  if (event === "task.updated" && data?.task?.id) {
    const task = data.task;
    const r = taskNotices(st.tasks.get(task.id), task, now);
    st.tasks.set(task.id, r.facts);
    out.push(...r.notices);
  } else if (event === "task.deleted" && data?.id) {
    st.tasks.delete(data.id);
  } else if (event === "task.event" && data?.event?.kind === "jira.moved") {
    const ev = data.event;
    const id = `${ev.taskId}|${ev.at}|${ev.payload?.status}`;
    if (!st.events.has(id)) {
      st.events.add(id);
      const task = (app.tasks ?? []).find((t) => t.id === ev.taskId);
      if (task) {
        const key = ev.payload?.key ?? task.jira?.key ?? "the issue";
        out.push({ title: "Jira", body: `${flat(key)} moved to ${flat(ev.payload?.status ?? "?")} while #${shortId(task)} ${task.running ? "runs" : "waits"}`, level: "info" });
      }
    }
  } else if (event === "github.prs") {
    for (const pr of data?.snapshot?.prs ?? []) {
      const key = `${pr.repo}#${pr.number}`;
      const n = prNotice(st.prs.get(key), pr);
      st.prs.set(key, pr.split);
      if (n) out.push(n);
    }
  } else if (event === "slack.items" && data?.snapshot?.items) {
    const items = data.snapshot.items;
    if (!st.slack) st.slack = new Map(items.map((i) => [i.id, slackFacts(i)]));
    else {
      for (const i of items) {
        const n = slackNotice(st.slack.get(i.id), i, Boolean(data.snapshot.quiet));
        st.slack.set(i.id, slackFacts(i));
        if (n) out.push(n);
      }
    }
  } else if (event === "budget.alert") {
    const a = data?.alert ?? data ?? {};
    const id = `${a.engine ?? a.repo ?? a.scope}|${a.pct}`;
    if (!st.budget.has(id)) {
      st.budget.add(id);
      out.push({ title: "Budget", body: `${flat(a.engine ?? a.repo ?? a.scope ?? "A budget")} passed ${a.pct ?? "?"}% of its ceiling`, level: "warning" });
    }
  }
  return out;
}

/** The machine going away or coming back, from `app.link` between two looks. */
export function linkNotice(before, app) {
  if (before == null || before === app.link) return null;
  if (app.link === "offline") return { title: "Machine offline", body: flat(app.error ?? "The machine does not answer"), level: "error" };
  if (before === "offline") return { title: "Machine back", body: "The board reads the machine again", level: "success" };
  return null;
}

page({
  id: "luna-alerts",
  label: "Alerts",
  icon: "hand",
  hidden: true,
  render: () => null,
  onMessage: (app, msg, cx) => {
    const st = app.state("alerts");
    const notices = scan(app, st, msg);
    for (const n of notices) post(n);
    if (st.seeded && !st.timer) {
      st.timer = true;
      cx.timer.every(LINK_CHECK_MS, () => {
        const n = linkNotice(st.link, app);
        st.link = app.link;
        if (n) post(n);
      });
    }
    return false;
  },
});
