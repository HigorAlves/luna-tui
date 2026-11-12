// The dialogs of the ticket actions (actions.js): ask before a decision, retry with guidance,
// reject the release, edit the ticket, the plan, the cases and the triage record, correct the
// escalation reason, set the repo, Jira, findings, evidence feedback, duplicates and the worktree.
// Each is registered in DIALOGS (registry.js); the call it makes is in `submit`.
import { div } from "gpui-kit";
import { h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { closeOverlay, openOverlay, pickFolder, props } from "herdr";

import {
  RECORD_FIELDS,
  ESCALATION_REASONS,
  SEVERITIES,
  casesMarkdown,
  dismissBody,
  feedbackBody,
  findingBody,
  guidanceBody,
  lines,
  looksLikeJiraKey,
  parseCases,
  planPatch,
  recordValue,
  rejectReleaseBody,
  segment,
} from "./actions-rules.js";
import { area, boxed, field, label, option } from "./dialogs.js";
import { DIALOGS } from "./registry.js";
import { button } from "./ui.js";

const enc = encodeURIComponent;
const input = (placeholder, value = "") => InputState.new({ placeholder, value });
const textarea = (placeholder, rows = 4, value = "") => TextareaState.new({ placeholder, rows, value });
const note = (t, text) => div().pt(8).text_size(12.5).text_color(t.foreground).child(text);
const hint = (t, text) => div().pt(6).text_size(11.5).text_color(t.dim).child(text);

/** The message in place of a refusal's own, for the refusals this file can explain. */
const explain = (words) => (call) => async () => {
  try {
    return await call();
  } catch (e) {
    const w = words[e?.code];
    if (w) throw new Error(w);
    throw e;
  }
};

/** A decision, as the board sends it: connected first, so the approver's name rides along. */
async function decide(m, taskId, decision, extra = {}) {
  await m.connect().catch(() => null);
  return m.decide(taskId, decision, extra);
}

/** Closes this dialog and opens another in its place. */
function swap(spec, height, width = 460) {
  openOverlay({ mod: "luna", kind: "dialog", width, height, props: { dialog: spec } });
  closeOverlay(props().overlay);
}

function fail(app, cx, message) {
  if (app.fail) app.fail(cx, message);
  else {
    app.error = message;
    cx.notify();
  }
}

/** An input whose edits redraw the dialog (a filter over a list). */
function filterInput(placeholder) {
  const state = input(placeholder);
  state.on("change", (_e, cx) => cx.notify());
  return state;
}

// ---- decisions ----

// Ask once before a decision: `{taskId, body, label, extra?}`. A refusal for coverage gaps opens the excuse dialog.
DIALOGS.approve_ask = {
  title: "Approve",
  height: 250,
  body: (app, t, d) => [note(t, d.body ?? "")],
  primary: (app, d) => ({ label: d.label ?? "Approve", kind: "primary" }),
  submit: (app, cx, d) =>
    app.send(cx, async () => {
      try {
        return await decide(app.machine, d.taskId, "approved", d.extra ?? {});
      } catch (e) {
        if (e?.code === "coverage_gaps") {
          const gaps = e.body?.gaps ?? [];
          swap({ kind: "excuse", taskId: d.taskId, gaps }, Math.min(560, 220 + gaps.length * 34));
          return null;
        }
        throw e;
      }
    }),
};

// Retry an escalated card; the note is the guidance the stage reads (optional).
DIALOGS.guidance = {
  title: "Retry with guidance",
  height: 330,
  init: (app) => {
    app.note = textarea("What it should do differently (optional)", 4);
  },
  body: (app, t) => [note(t, "The stage runs again and reads your note first."), ...area(t, "Guidance", app.note, 90)],
  primary: () => ({ label: "Retry", kind: "primary" }),
  submit: (app, cx, d) => app.send(cx, () => decide(app.machine, d.taskId, "approved", guidanceBody(app.note.value()))),
};

// Reject the release: the card is archived, and the comment stays on it.
DIALOGS.reject_release = {
  title: "Reject the release",
  height: 340,
  init: (app) => {
    app.note = textarea("Why it is not safe to release", 4);
  },
  body: (app, t) => [note(t, "The card ends archived. The comment is kept on it."), ...area(t, "Comment", app.note, 90)],
  primary: () => ({ label: "Reject the release", kind: "danger" }),
  submit: (app, cx, d) => {
    if (!app.note.value().trim()) return fail(app, cx, "Say why: the reason is kept on the ticket.");
    return app.send(cx, () => decide(app.machine, d.taskId, "rejected", rejectReleaseBody(app.note.value())));
  },
};

// ---- edits ----

DIALOGS.edit_ticket = {
  title: "Edit the ticket",
  height: 560,
  width: 560,
  init: (app, _cx, d) => {
    app.title = input("What should be done", d.ticketTitle ?? "");
    app.description = textarea("Description", 5, d.description ?? "");
    app.criteria = textarea("One criterion per line", 5, (d.criteria ?? []).join("\n"));
  },
  body: (app, t) => [...field(t, "Title", app.title), ...area(t, "Description", app.description, 100), ...area(t, "Acceptance criteria, one per line", app.criteria, 100)],
  primary: () => ({ label: "Save", kind: "primary" }),
  submit: (app, cx, d) => {
    const title = app.title.value().trim();
    if (!title) return fail(app, cx, "Give it a title.");
    const body = {};
    const description = app.description.value().trim();
    const criteria = lines(app.criteria.value());
    if (title !== (d.ticketTitle ?? "")) body.title = title;
    if (description !== (d.description ?? "").trim()) body.description = description;
    if (JSON.stringify(criteria) !== JSON.stringify(d.criteria ?? [])) body.criteria = criteria;
    if (!Object.keys(body).length) return fail(app, cx, "Nothing changed.");
    return app.send(cx, () => app.machine.patch(`/tasks/${enc(d.taskId)}`, body));
  },
};

DIALOGS.edit_plan = {
  title: "Edit the plan",
  height: 640,
  width: 580,
  init: (app, _cx, d) => {
    const p = d.plan;
    app.brief = textarea("The brief", 5, p.brief);
    app.criteria = textarea("One criterion per line", 4, p.criteria.join("\n"));
    app.assumptions = textarea("One assumption per line", 3, p.assumptions.join("\n"));
    if (d.full) {
      app.steps = textarea("One step per line", 5, p.steps.map((s) => s.description).join("\n"));
      app.rollback = textarea("How to roll it back", 3, p.rollback);
      app.riskReason = input("Why this risk", p.risk?.reason ?? "");
      app.riskLevel = p.risk?.level ?? null;
    }
  },
  body: (app, t, d) => {
    const out = [...area(t, "Brief", app.brief, 100), ...area(t, "Criteria to build, one per line", app.criteria, 80), ...area(t, "Assumptions, one per line", app.assumptions, 60)];
    if (d.full) {
      out.push(...area(t, "Steps, one per line (files and sizes stay as they are)", app.steps, 100), ...area(t, "Rollback", app.rollback, 60), label(t, "Risk"));
      out.push(
        h_flex().gap(6).children(["low", "medium", "high"].map((level) => button(t, `risk-${level}`, level, app.riskLevel === level ? "primary" : "plain", (_e, cx) => {
          app.riskLevel = level;
          cx.notify();
        }, { small: true }))),
        hint(t, "The machine's own level is a floor: a lower one is kept with its reason, and Ship still reads the higher."),
        boxed(t, Input.new(app.riskReason).w_full()),
      );
    } else {
      out.push(hint(t, "The plan is approved: its steps, risk and rollback are fixed. The brief, criteria and assumptions can still change."));
    }
    return out;
  },
  primary: () => ({ label: "Save", kind: "primary" }),
  submit: (app, cx, d) => {
    const now = {
      brief: app.brief.value(),
      criteria: lines(app.criteria.value()),
      assumptions: lines(app.assumptions.value()),
      steps: d.full ? lines(app.steps.value()) : [],
      rollback: d.full ? app.rollback.value() : "",
      riskLevel: d.full ? app.riskLevel : null,
      riskReason: d.full ? app.riskReason.value() : "",
    };
    if (d.full && now.riskLevel && !now.riskReason.trim() && (now.riskLevel !== d.plan.risk?.level)) return fail(app, cx, "Say why the risk changes.");
    const body = planPatch(d.plan, now, d.full);
    if (!Object.keys(body).length) return fail(app, cx, "Nothing changed.");
    return app.send(cx, explain({ plan_approved: "The plan is approved: its steps, risk and rollback can no longer change.", no_plan: "This ticket has no plan to edit now." })(() => app.machine.patch(`/tasks/${enc(d.taskId)}/plan`, body)));
  },
};

DIALOGS.edit_cases = {
  title: "Edit the test cases",
  height: 560,
  width: 580,
  init: (app, _cx, d) => {
    app.text = textarea("## criterion, then - case, its approach under it", 16, casesMarkdown(d.cases ?? []));
  },
  body: (app, t) => [hint(t, "One ## heading per criterion, one - bullet per case, the approach under it."), boxed(t, Textarea.new(app.text).w_full(), 360)],
  primary: () => ({ label: "Save", kind: "primary" }),
  submit: (app, cx, d) => {
    const cases = parseCases(app.text.value());
    if (!cases.length) return fail(app, cx, "Keep at least one case; Send back returns the whole set instead.");
    const before = parseCases(casesMarkdown(d.cases ?? []));
    if (JSON.stringify(cases) === JSON.stringify(before)) return fail(app, cx, "Nothing changed.");
    return app.send(cx, explain({ no_cases: "The cases can only change while they wait for your check." })(() => app.machine.patch(`/tasks/${enc(d.taskId)}/cases`, { cases })));
  },
};

DIALOGS.edit_record = {
  title: "Correct the triage record",
  height: 430,
  init: (app, _cx, d) => {
    app.picks = { ...(d.current ?? {}) };
  },
  body: (app, t, d) => {
    const out = [hint(t, "A value you change is kept as ground truth. A lower risk than the machine's is kept and shown, but the plan's floor still reads the higher.")];
    for (const [key, words, values] of RECORD_FIELDS) {
      out.push(
        label(t, words),
        h_flex().gap(5).flex_wrap().children(values.map((v) => button(t, `rec-${key}-${v}`, v, app.picks[key] === v ? "primary" : "plain", (_e, cx) => {
          app.picks[key] = v;
          cx.notify();
        }, { small: true }))),
      );
    }
    return out;
  },
  primary: () => ({ label: "Save", kind: "primary" }),
  submit: (app, cx, d) => {
    const body = {};
    for (const [key] of RECORD_FIELDS) if (app.picks[key] && app.picks[key] !== (d.current ?? {})[key]) body[key] = app.picks[key];
    if (!Object.keys(body).length) return fail(app, cx, "Nothing changed.");
    return app.send(cx, explain({ record_locked: "The record is corrected at triage's questions or at the plan gate." })(() => app.machine.patch(`/tasks/${enc(d.taskId)}/record`, body)));
  },
};

DIALOGS.escalation_reason = {
  title: "Correct the escalation reason",
  height: 370,
  body: (app, t, d) => [
    hint(t, "The card stays where it is; only the reason it was decided with changes."),
    ...ESCALATION_REASONS.map(([id, words]) => option(t, `er-${id}`, words, d.current === id, (_e, cx) => app.send(cx, () => app.machine.post(`/tasks/${enc(d.taskId)}/escalation-reason`, { reason: id })))),
  ],
  primary: () => null,
};

const HAS_WORKTREE = "This ticket already works on a branch in a worktree, so its repository stays. Remove the worktree first, then set the repository again.";

DIALOGS.set_repo = {
  title: "Set the repository",
  height: 480,
  init: (app) => {
    app.filter = filterInput("Filter the repositories the machine knows");
  },
  body: (app, t, d) => {
    const q = app.filter.value().trim().toLowerCase();
    const repos = (d.repos ?? []).filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 8);
    const choose = (cx, path) => app.send(cx, explain({ has_worktree: HAS_WORKTREE })(() => app.machine.patch(`/tasks/${enc(d.taskId)}`, { repoPath: path })));
    return [
      note(t, d.current ? `Now: ${d.current}` : "This ticket has no repository yet."),
      ...field(t, "Search", app.filter),
      label(t, "Known repositories"),
      ...(repos.length ? repos.map((r) => option(t, `sr-${r}`, r, d.current === r, (_e, cx) => choose(cx, r))) : [hint(t, "No match.")]),
      div().pt(10).child(button(t, "sr-pick", "Choose a folder…", "plain", (_e, cx) => {
        cx.spawn(async (cx) => {
          const folder = await pickFolder({ prompt: "Use this repository" });
          if (folder) choose(cx, folder.replace(/\/+$/, ""));
        });
      }, { iconName: "folder" })),
    ];
  },
  primary: () => null,
};

// ---- Jira ----

DIALOGS.jira_link = {
  title: "Link a Jira issue",
  height: 480,
  init: (app, _cx, d) => {
    app.hits = [];
    app.searching = false;
    app.searched = null;
    app.query = input("An issue key (PLAT-123) or words");
    app.query.on("submit", (_e, cx) => DIALOGS.jira_link.search(app, cx));
    app.query.focus();
  },
  search: (app, cx) => {
    const q = app.query.value().trim();
    if (q.length < 2 || app.searching) return;
    app.searching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        app.hits = (await app.machine.get(`/jira/search?q=${enc(q)}`)) ?? [];
        app.searched = q;
        app.error = null;
      } catch (e) {
        app.error = e?.message ?? String(e);
      }
      app.searching = false;
      cx.notify();
    });
  },
  body: (app, t, d) => {
    const key = app.query.value().trim().toUpperCase();
    const link = (cx, k) => app.send(cx, explain({
      already_linked_elsewhere: "Another open ticket holds that issue: close or unlink it first.",
      has_worktree: "This ticket already works on a branch named from another issue.",
      no_issue: "Jira has no such issue.",
    })(() => app.machine.post(`/tasks/${enc(d.taskId)}/jira`, { key: k })));
    return [
      ...field(t, "Search", app.query),
      h_flex().pt(8).gap(6)
        .child(button(t, "jl-search", app.searching ? "Searching…" : "Search", "plain", (_e, cx) => DIALOGS.jira_link.search(app, cx), { busy: app.searching }))
        .when(looksLikeJiraKey(key), (el) => el.child(button(t, "jl-key", `Link ${key}`, "primary", (_e, cx) => link(cx, key)))),
      label(t, app.searched ? `Matches for "${app.searched}"` : "Matches"),
      ...(app.hits.length
        ? app.hits.map((h) => option(t, `jl-${h.key}`, `${h.key}  ${h.summary ?? ""}${h.status ? `  (${h.status})` : ""}`, false, (_e, cx) => link(cx, h.key)))
        : [hint(t, app.searched ? "No issue matches." : "Press Enter to search.")]),
    ];
  },
  primary: () => null,
};

DIALOGS.jira_create = {
  title: "Create a Jira issue",
  height: 330,
  init: (app) => {
    app.project = input("Project key (default: the repository's luna.yaml project)");
    app.issueType = input("Issue type", "Task");
  },
  body: (app, t) => [note(t, "An issue is made from the ticket (title, description, the criteria as a checklist) and linked."), ...field(t, "Project", app.project), ...field(t, "Issue type", app.issueType)],
  primary: () => ({ label: "Create", kind: "primary" }),
  submit: (app, cx, d) => {
    const body = {};
    if (app.project.value().trim()) body.project = app.project.value().trim().toUpperCase();
    if (app.issueType.value().trim()) body.issueType = app.issueType.value().trim();
    return app.send(cx, explain({
      already_linked: "The ticket already carries a Jira issue.",
      no_project: "No project: name one here, or set jira.project in the repository's luna.yaml.",
    })(() => app.machine.post(`/tasks/${enc(d.taskId)}/jira/create`, body)));
  },
};

// ---- findings ----

DIALOGS.finding_dismiss = {
  title: "Dismiss a finding",
  height: 480,
  init: (app, _cx, d) => {
    app.picked = (d.findings ?? []).length === 1 ? d.findings[0].id : null;
    app.reason = input("Why it is not a problem (optional)");
  },
  body: (app, t, d) => [
    note(t, "A finding Verify reported. Your reason is kept as ground truth."),
    label(t, "Finding"),
    ...(d.findings ?? []).map((f) => option(t, `fd-${f.id}`, `${f.severity ?? ""}  ${f.title}${f.path ? `  ${f.path}${f.line ? `:${f.line}` : ""}` : ""}`, app.picked === f.id, (_e, cx) => {
      app.picked = f.id;
      cx.notify();
    })),
    ...field(t, "Reason", app.reason),
  ],
  primary: () => ({ label: "Dismiss", kind: "primary" }),
  submit: (app, cx, d) => {
    if (!app.picked) return fail(app, cx, "Pick the finding to dismiss.");
    return app.send(cx, explain({ finding_unknown: "Verify did not report that finding." })(() => app.machine.post(`/tasks/${enc(d.taskId)}/findings/${segment(app.picked)}/dismiss`, dismissBody(app.reason.value()))));
  },
};

DIALOGS.finding_add = {
  title: "Add a finding Verify missed",
  height: 400,
  init: (app) => {
    app.severity = "should_fix";
    app.title = input("What is wrong");
    app.path = input("File (optional)");
    app.line = input("Line (optional)");
  },
  body: (app, t) => [
    label(t, "Severity"),
    h_flex().gap(5).children(SEVERITIES.map(([id, words]) => button(t, `fa-${id}`, words, app.severity === id ? "primary" : "plain", (_e, cx) => {
      app.severity = id;
      cx.notify();
    }, { small: true }))),
    ...field(t, "Title", app.title),
    ...field(t, "File", app.path),
    ...field(t, "Line", app.line),
  ],
  primary: () => ({ label: "Add", kind: "primary" }),
  submit: (app, cx, d) => {
    if (!app.title.value().trim()) return fail(app, cx, "Give the finding a title.");
    return app.send(cx, () => app.machine.post(`/tasks/${enc(d.taskId)}/findings`, findingBody({ severity: app.severity, title: app.title.value(), path: app.path.value(), line: app.line.value() })));
  },
};

// ---- evidence, duplicates, worktree ----

DIALOGS.evidence_feedback = {
  title: "Was the Evidence Pack useful?",
  height: 310,
  init: (app) => {
    app.note = textarea("A short note (optional)", 3);
  },
  body: (app, t, d) => [note(t, d.useful ? "Marked useful. The machine keeps it as ground truth; it labels no decision." : "Marked not useful. Say what was missing, if you like."), ...area(t, "Note", app.note, 70)],
  primary: (app, d) => ({ label: d.useful ? "Useful" : "Not useful", kind: "primary" }),
  submit: (app, cx, d) => app.send(cx, () => app.machine.post(`/tasks/${enc(d.taskId)}/evidence/feedback`, feedbackBody(d.useful, app.note.value()))),
};

DIALOGS.merge_into = {
  title: "Close as a duplicate",
  height: 460,
  init: (app) => {
    app.filter = filterInput("Find the ticket it duplicates");
  },
  body: (app, t, d) => {
    const q = app.filter.value().trim().toLowerCase();
    const rows = (d.candidates ?? []).filter((c) => !q || `${c.title} ${c.id}`.toLowerCase().includes(q)).slice(0, 8);
    return [
      note(t, "This ticket closes, merged into the one you pick. Close as a duplicate can be undone with Bring it back."),
      ...field(t, "Search", app.filter),
      label(t, "Duplicate of"),
      ...(rows.length ? rows.map((c) => option(t, `mi-${c.id}`, `${c.title}  (${c.state})`, false, (_e, cx) => app.send(cx, explain({ merge_invalid: "That ticket cannot take this one." })(() => app.machine.post(`/tasks/${enc(d.taskId)}/merge`, { into: c.id }))))) : [hint(t, "No other ticket matches.")]),
    ];
  },
  primary: () => null,
};

// Remove the worktree; commits the machine has not pushed ask again, and `?discard=true` removes it anyway.
DIALOGS.remove_worktree = {
  title: "Remove the worktree",
  height: 280,
  init: (app) => {
    app.discard = false;
    app.warning = null;
  },
  body: (app, t) => [
    note(t, "The work folder and the machine's repository for the card go. The ticket and its branch stay."),
    ...(app.discard ? [div().pt(8).text_size(12.5).text_color(t.blocked).child(`${app.warning} Remove it anyway? Those commits are lost.`)] : []),
  ],
  primary: (app) => ({ label: app.discard ? "Remove anyway" : "Remove", kind: "danger" }),
  submit: (app, cx, d) =>
    app.send(cx, async () => {
      try {
        return await app.machine.post(`/tasks/${enc(d.taskId)}/worktree/remove${app.discard ? "?discard=true" : ""}`);
      } catch (e) {
        if (e?.code === "unpushed_commits" && !app.discard) {
          app.discard = true;
          app.warning = e.message || "The card holds commits the machine has not pushed.";
          throw new Error("Not removed: the card holds commits the machine has not pushed. Press Remove anyway to discard them.");
        }
        throw e;
      }
    }),
};
