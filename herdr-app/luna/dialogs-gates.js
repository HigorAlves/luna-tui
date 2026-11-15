// The dialogs of the gates: approve (asking first), retry with guidance, send back, reject, reject the
// release, answer the questions, give context, excuse the untestable criteria, decide a duplicate.
// Every decision is sent with `decideIfStill`: the dialog captured `expect = gateKey(task)` when it
// opened, and a card that moved on since gets a word about it and nothing is sent (the TUI's
// `still_at_gate`). Each is registered in DIALOGS (registry.js); the call it makes is in `submit`.
import { div } from "gpui-kit";
import { h_flex, InputState, TextareaState } from "gpui-base";
import { closeOverlay, openOverlay, props } from "herdr";

import { guidanceBody, openGaps, partialApproval, rejectReleaseBody, sendBackBody } from "./actions-rules.js";
import { area, field, label, option } from "./dialogs.js";
import { DIALOGS } from "./registry.js";
import { button } from "./ui.js";

const input = (placeholder, value = "") => InputState.new({ placeholder, value });
const textarea = (placeholder, rows = 4, value = "") => TextareaState.new({ placeholder, rows, value });
const note = (t, text) => div().pt(8).text_size(12.5).text_color(t.foreground).child(text);
const hint = (t, text) => div().pt(6).text_size(11.5).text_color(t.dim).child(text);

function fail(app, cx, message) {
  if (app.fail) app.fail(cx, message);
  else {
    app.error = message;
    cx.notify();
  }
}

/**
 * A decision on the gate the dialog was opened for. Sends only while the card is still there
 * (`decideIfStill`); a dialog opened without `expect` (nothing captured it) falls back to a plain decide.
 */
export function decideHere(app, d, decision, extra = {}) {
  const m = app.machine;
  return d.expect != null && m.decideIfStill ? m.decideIfStill(d.taskId, d.expect, decision, extra) : m.decide(d.taskId, decision, extra);
}

/** Closes this dialog and opens another in its place. */
function swap(spec, height, width = 460) {
  openOverlay({ mod: "luna", kind: "dialog", width, height, props: { dialog: spec } });
  closeOverlay(props().overlay);
}

/** After an approval that may have left the gate open (more names needed): says who approved and how many more, on the board. */
async function announcePartial(app, d) {
  if (!(d.needed > 1)) return;
  try {
    const text = partialApproval(await app.machine.detail(d.taskId), app.machine.approver);
    if (text) app.handBack?.("bulk", { done: 1, text, failed: 0 });
  } catch {
    // the approval went through; only the note is lost
  }
}

// ---- approve ----

// Ask once before a decision: `{taskId, expect, title, body, label, extra?, needed?}`. A refusal for coverage gaps opens the excuse dialog.
DIALOGS.approve_ask = {
  title: "Approve",
  height: 250,
  body: (app, t, d) => [note(t, d.body ?? "")],
  primary: (app, d) => ({ label: d.label ?? "Approve", kind: "primary" }),
  submit: (app, cx, d) =>
    app.send(cx, async () => {
      try {
        const out = await decideHere(app, d, "approved", d.extra ?? {});
        await announcePartial(app, d);
        return out;
      } catch (e) {
        if (e?.code === "coverage_gaps") {
          const gaps = openGaps(e.body?.gaps ?? [], d.excused);
          swap({ kind: "excuse", taskId: d.taskId, expect: d.expect, gaps, excused: d.excused ?? [], needed: d.needed, subtitle: d.subtitle }, Math.min(560, 240 + gaps.length * 34));
          return null;
        }
        throw e;
      }
    }),
};

// Retry an escalated card; the note is the guidance the stage reads (optional). Only while it is still escalated.
DIALOGS.guidance = {
  title: "Retry with guidance",
  height: 330,
  init: (app) => {
    app.note = textarea("What it should do differently (optional)", 4);
  },
  body: (app, t) => [note(t, "The stage runs again and reads your note first."), ...area(t, "Guidance", app.note, 90)],
  primary: () => ({ label: "Retry", kind: "primary" }),
  submit: (app, cx, d) => app.send(cx, () => decideHere(app, d, "approved", guidanceBody(app.note.value()))),
};

// Excuse the criteria no test covers. Nothing is ticked at first, and at least one must be.
DIALOGS.excuse = {
  title: "Approve, excusing the gaps",
  height: 420,
  init: (app) => {
    app.picked = new Set();
  },
  body: (app, t, d) => {
    const gaps = openGaps(d.gaps, d.excused);
    const out = [note(t, "No test covers these criteria, so Build would refuse the plan. Tick the ones that cannot be tested: they are kept as untestable.")];
    if (!gaps.length) out.push(hint(t, "Nothing is left to excuse: approve again."));
    for (const g of gaps) {
      const id = g.id ?? g;
      out.push(option(t, `gap-${id}`, `${id}${g.text ? `: ${g.text}` : ""}`, app.picked.has(id), (_e, cx) => {
        app.picked.has(id) ? app.picked.delete(id) : app.picked.add(id);
        cx.notify();
      }));
    }
    return out;
  },
  primary: () => ({ label: "Approve", kind: "primary" }),
  submit: (app, cx, d) => {
    if (!app.picked.size) return fail(app, cx, "Tick at least one criterion that cannot be tested.");
    return app.send(cx, async () => {
      const out = await decideHere(app, d, "approved", { untestable: [...app.picked] });
      await announcePartial(app, d);
      return out;
    });
  },
};

// ---- send back and reject ----

// Send back: the stage reads the reason, so it is required. At the ship gate the note may carry a time and element.
DIALOGS.send_back = {
  title: "Send it back",
  height: 300,
  init: (app, _cx, d) => {
    app.reason = textarea(d.shipGate ? "What to change (t=12.5 scene=<id> el=<id> …)" : "What should change", 4);
  },
  body: (app, t, d) => [note(t, "The stage runs again and reads your reason."), ...area(t, d.shipGate ? "What to change" : "Reason", app.reason, 90)],
  primary: () => ({ label: "Send back", kind: "primary" }),
  submit: (app, cx, d) => {
    const body = sendBackBody(app.reason.value());
    if (!body) return fail(app, cx, "Say why it goes back: the stage reads your reason.");
    return app.send(cx, () => decideHere(app, d, "sent_back", body));
  },
};

// Reject the plan or split: the card ends and the comment is kept.
DIALOGS.reject = {
  title: "Reject the plan",
  height: 300,
  init: (app) => {
    app.reason = textarea("Why it is rejected", 4);
  },
  body: (app, t) => [note(t, "The card ends archived as rejected. The comment is kept on it."), ...area(t, "Reason", app.reason, 90)],
  primary: () => ({ label: "Reject", kind: "danger" }),
  submit: (app, cx, d) => {
    const comment = app.reason.value().trim();
    if (!comment) return fail(app, cx, "Say why: the reason is kept on the ticket.");
    return app.send(cx, () => decideHere(app, d, "rejected", { comment }));
  },
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
    return app.send(cx, () => decideHere(app, d, "rejected", rejectReleaseBody(app.note.value())));
  },
};

// ---- questions, context, duplicates ----

// Triage's questions, each answer starting from its recommendation. `questions` and `recommended` are parallel lists.
DIALOGS.answer = {
  title: "Answer the questions",
  height: 500,
  init: (app, _cx, d) => {
    app.answers = (d.questions ?? []).map((q, i) => textarea(String(q).slice(0, 80), 2, d.recommended?.[i] ?? ""));
  },
  body: (app, t, d) => {
    const out = [];
    const anyRecommended = (d.recommended ?? []).some(Boolean);
    if (anyRecommended) out.push(hint(t, "Triage's recommended answers are filled in: edit them or keep them."));
    (d.questions ?? []).forEach((q, i) => out.push(...area(t, `${i + 1}. ${q}`, app.answers[i], 52)));
    return out;
  },
  primary: () => ({ label: "Send answers", kind: "primary" }),
  submit: (app, cx, d) => {
    const answers = Object.fromEntries((d.questions ?? []).map((q, i) => [String(q), app.answers[i].value().trim()]).filter(([, a]) => a));
    if (!Object.keys(answers).length) return fail(app, cx, "Answer at least one question.");
    return app.send(cx, () => app.machine.answer(d.taskId, answers));
  },
};

// Give Intake what it asked for: the repository, the project, or a text. At least one, and it must say something new.
DIALOGS.context = {
  title: "Give it context",
  height: 440,
  init: (app, _cx, d) => {
    app.repo = input("Absolute path of the repository", d.repoPath ?? "");
    app.project = input("The project's name");
    app.reason = textarea("What it needs to know", 4);
  },
  body: (app, t) => [...field(t, "Repository", app.repo), ...field(t, "Project", app.project), ...area(t, "Context", app.reason, 80)],
  primary: () => ({ label: "Send", kind: "primary" }),
  submit: (app, cx, d) => {
    const given = {};
    const repo = app.repo.value().trim();
    if (repo && repo !== (d.repoPath ?? "")) given.repoPath = repo;
    if (app.project.value().trim()) given.project = app.project.value().trim();
    if (app.reason.value().trim()) given.text = app.reason.value().trim();
    if (!Object.keys(given).length) return fail(app, cx, "Give a repository, a project or some text: there is nothing to send yet.");
    return app.send(cx, () => app.machine.context(d.taskId, given));
  },
};

// Is it a duplicate? One candidate it duplicates, the ones that are only related (the ticked ones), or neither.
DIALOGS.dedup = {
  title: "Is it a duplicate?",
  height: 420,
  init: (app) => {
    app.related = new Set();
  },
  body: (app, t, d) => {
    const cands = d.candidates ?? [];
    const out = [label(t, "It duplicates")];
    for (const c of cands) out.push(option(t, `dd-${c.id}`, `Duplicate of: ${c.title}`, false, (_e, cx) => app.send(cx, () => app.machine.dedup(d.taskId, "duplicate", [c.id]))));
    out.push(label(t, "Or it is related to (tick which, keep both)"));
    for (const c of cands) {
      out.push(option(t, `dr-${c.id}`, c.title, app.related.has(c.id), (_e, cx) => {
        app.related.has(c.id) ? app.related.delete(c.id) : app.related.add(c.id);
        cx.notify();
      }));
    }
    out.push(
      h_flex().pt(6).child(button(t, "dd-related", app.related.size ? `Related to ${app.related.size}, keep both` : "Related, keep both", "plain", (_e, cx) => {
        if (!app.related.size) return fail(app, cx, "Tick the tickets it is related to.");
        return app.send(cx, () => app.machine.dedup(d.taskId, "related", [...app.related]));
      })),
      option(t, "dd-neither", "Neither: it is new", false, (_e, cx) => app.send(cx, () => app.machine.dedup(d.taskId, "neither", []))),
    );
    return out;
  },
  primary: () => null,
};
