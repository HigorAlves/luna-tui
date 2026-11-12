// Dialogs: this mod opened again as an overlay with `props().dialog`. Each dialog makes its own
// call to the machine and closes; the board sees the result on the stream. What the board must
// act on (a task to select, a repo to filter by) goes back through shared state.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { closeOverlay, pickFolder, props, setShared } from "herdr";

import { ARCHIVE_REASONS } from "./model.js";
import { button, icon, mono, toneColor } from "./ui.js";

const TITLES = {
  send_back: "Send it back",
  reject: "Reject the plan",
  archive: "Archive the ticket",
  delete: "Delete the ticket",
  answer: "Answer the questions",
  context: "Give it context",
  excuse: "Approve, excusing the gaps",
  merge: "Merge the pull request",
  new_task: "New task",
  repos: "Filter by repository",
  dedup: "Is it a duplicate?",
};

/** Sets the dialog's inputs up; runs once, in `init`. */
export function initDialog(app, cx) {
  const d = props().dialog;
  app.d = d;
  app.error = null;
  app.sending = false;
  app.handle = cx.focus_handle();
  const field = (placeholder, value = "") => InputState.new({ placeholder, value });
  const area = (placeholder, rows = 4, value = "") => TextareaState.new({ placeholder, rows, value });
  if (d.kind === "send_back") app.reason = area("What should change (optional)", 4);
  if (d.kind === "reject") app.reason = area("Why it is rejected", 4);
  if (d.kind === "answer") app.answers = (d.questions ?? []).map((q) => area(String(q).slice(0, 80), 2));
  if (d.kind === "context") {
    app.repo = field("Absolute path of the repository", d.repoPath ?? "");
    app.reason = area("What it needs to know", 4);
  }
  if (d.kind === "new_task") {
    app.title = field("What should be done");
    app.repo = field("/path/to/repository", d.repoPath ?? "");
    app.reason = area("Description (optional)", 4);
    app.criteria = area("Acceptance criteria, one per line (optional)", 4);
    app.startNow = true;
    app.title.focus();
    cx.timer.after(400, () => app.title.focus());
  }
  app.picked = d.kind === "excuse" ? new Set((d.gaps ?? []).map((g) => g.id ?? g)) : null;
}

function finish(app, select = null) {
  if (select) setShared("luna.select", { id: select, at: Date.now() });
  closeOverlay(props().overlay);
}

async function send(app, cx, call) {
  if (app.sending) return;
  app.sending = true;
  app.error = null;
  cx.notify();
  try {
    const out = await call();
    finish(app, out?.select ?? null);
  } catch (e) {
    app.error = e?.message ?? String(e);
    app.sending = false;
    cx.notify();
  }
}

function submit(app, cx) {
  const d = app.d;
  const m = app.machine;
  switch (d.kind) {
    case "send_back":
      return send(app, cx, () => m.decide(d.taskId, "sent_back", app.reason.value().trim() ? { reason: app.reason.value().trim() } : {}));
    case "reject": {
      const comment = app.reason.value().trim();
      if (!comment) {
        app.error = "Say why: the reason is kept on the ticket.";
        return cx.notify();
      }
      return send(app, cx, () => m.decide(d.taskId, "rejected", { comment }));
    }
    case "delete":
      return send(app, cx, () => m.remove(d.taskId));
    case "answer": {
      const answers = Object.fromEntries((d.questions ?? []).map((q, i) => [String(q), app.answers[i].value().trim()]).filter(([, a]) => a));
      if (!Object.keys(answers).length) {
        app.error = "Answer at least one question.";
        return cx.notify();
      }
      return send(app, cx, () => m.answer(d.taskId, answers));
    }
    case "context": {
      const given = {};
      if (app.repo.value().trim()) given.repoPath = app.repo.value().trim();
      if (app.reason.value().trim()) given.text = app.reason.value().trim();
      return send(app, cx, () => m.context(d.taskId, given));
    }
    case "excuse":
      return send(app, cx, () => m.decide(d.taskId, "approved", { untestable: [...app.picked] }));
    case "merge":
      return send(app, cx, () => m.mergePr(d.repo, d.number));
    case "new_task": {
      const title = app.title.value().trim();
      if (!title) {
        app.error = "Give it a title.";
        return cx.notify();
      }
      const criteria = app.criteria.value().split("\n").map((c) => c.trim()).filter(Boolean);
      const repoPath = app.repo.value().trim() || null;
      return send(app, cx, async () => {
        const task = await m.create({ title, description: app.reason.value().trim(), criteria, repoPath, start: app.startNow });
        return { select: task?.id };
      });
    }
    default:
      return finish(app);
  }
}

function label(t, text) {
  return div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text);
}

function boxed(t, el, h = 34) {
  return div().w_full().min_h(h).px(10).py(7).rounded(8).bg(t.background).border_1().border_color(t.input).text_size(12.8).text_color(t.foreground).child(el);
}

function option(t, id, text, on, onClick) {
  return h_flex()
    .id(id)
    .h(32)
    .px(10)
    .gap(9)
    .items_center()
    .rounded(7)
    .cursor_pointer()
    .text_size(12.5)
    .when(on, (el) => el.bg(t.selected))
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(div().size(14).flex_none().rounded(4).border_1().border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent)).flex().items_center().justify_center().when(on, (el) => el.child(icon("check", 10, t.accent_foreground))))
    .child(div().flex_1().min_w(0).text_color(t.foreground).child(text));
}

/** The dialog's body. */
export function renderDialog(app, t) {
  const d = app.d;
  const body = [];
  let primary = { label: "Send", kind: "primary" };
  if (d.subtitle) body.push(div().text_size(12.5).text_color(t.muted).child(d.subtitle));
  switch (d.kind) {
    case "send_back":
      body.push(label(t, "Reason"), boxed(t, Textarea.new(app.reason).w_full(), 80));
      primary = { label: "Send back", kind: "primary" };
      break;
    case "reject":
      body.push(label(t, "Reason"), boxed(t, Textarea.new(app.reason).w_full(), 80));
      primary = { label: "Reject", kind: "danger" };
      break;
    case "delete":
      body.push(div().pt(8).text_size(12.5).text_color(t.foreground).child("Its runs, approvals and events go with it. This cannot be undone."));
      primary = { label: "Delete", kind: "danger" };
      break;
    case "archive":
      body.push(label(t, "Why"));
      ARCHIVE_REASONS.forEach(([id, words]) =>
        body.push(
          option(t, `ar-${id}`, words, false, (_e, cx) => send(app, cx, () => app.machine.archive(d.taskId, id))),
        ),
      );
      primary = null;
      break;
    case "answer":
      (d.questions ?? []).forEach((q, i) => body.push(label(t, `${i + 1}. ${q}`), boxed(t, Textarea.new(app.answers[i]).w_full(), 52)));
      primary = { label: "Send answers", kind: "primary" };
      break;
    case "context":
      body.push(label(t, "Repository"), boxed(t, Input.new(app.repo).w_full()), label(t, "Context"), boxed(t, Textarea.new(app.reason).w_full(), 80));
      break;
    case "excuse":
      body.push(div().pt(6).text_size(12.5).text_color(t.foreground).child("No test covers these criteria, so Build would refuse the plan. Tick the ones that cannot be tested: they are kept as untestable."));
      (d.gaps ?? []).forEach((g) => {
        const id = g.id ?? g;
        body.push(option(t, `gap-${id}`, `${id}${g.text ? `: ${g.text}` : ""}`, app.picked.has(id), (_e, cx) => {
          app.picked.has(id) ? app.picked.delete(id) : app.picked.add(id);
          cx.notify();
        }));
      });
      primary = { label: "Approve", kind: "primary" };
      break;
    case "merge":
      body.push(div().pt(8).text_size(12.5).text_color(t.foreground).child(`${d.repo}#${d.number} merges the way the repository allows and its branch is deleted.`));
      primary = { label: "Merge", kind: "primary" };
      break;
    case "dedup":
      (d.candidates ?? []).forEach((c) =>
        body.push(option(t, `dd-${c.id}`, `Duplicate of: ${c.title}`, false, (_e, cx) => send(app, cx, () => app.machine.dedup(d.taskId, "duplicate", [c.id])))),
      );
      body.push(option(t, "dd-related", "Related, keep both", false, (_e, cx) => send(app, cx, () => app.machine.dedup(d.taskId, "related", (d.candidates ?? []).map((c) => c.id)))));
      body.push(option(t, "dd-neither", "Neither: it is new", false, (_e, cx) => send(app, cx, () => app.machine.dedup(d.taskId, "neither", []))));
      primary = null;
      break;
    case "repos":
      (d.repos ?? []).forEach((r) =>
        body.push(option(t, `rp-${r}`, r, d.current === r, () => {
          setShared("luna.prRepo", { repo: r, at: Date.now() });
          closeOverlay(props().overlay);
        })),
      );
      primary = null;
      break;
    case "new_task":
      body.push(
        label(t, "Title"),
        boxed(t, Input.new(app.title).w_full()),
        label(t, "Repository"),
        h_flex()
          .gap(6)
          .child(div().flex_1().child(boxed(t, Input.new(app.repo).w_full())))
          .child(button(t, "pick-repo", "Choose…", "plain", (_e, cx) => {
            cx.spawn(async (cx) => {
              const folder = await pickFolder({ prompt: "Use this repository" });
              if (folder) {
                app.repo.set_value(folder);
                cx.notify();
              }
            });
          }, { iconName: "folder" })),
      );
      if (d.repos?.length) {
        body.push(
          h_flex()
            .pt(6)
            .gap(5)
            .flex_wrap()
            .children(d.repos.slice(0, 6).map((r) => button(t, `known-${r}`, r.split("/").at(-1), "quiet", (_e, cx) => { app.repo.set_value(r); cx.notify(); }, { small: true }))),
        );
      }
      body.push(label(t, "Description"), boxed(t, Textarea.new(app.reason).w_full(), 72), label(t, "Acceptance criteria"), boxed(t, Textarea.new(app.criteria).w_full(), 72));
      body.push(
        option(t, "start-now", "Start it now: triage runs at once", app.startNow, (_e, cx) => {
          app.startNow = !app.startNow;
          cx.notify();
        }),
      );
      primary = { label: "Create", kind: "primary" };
      break;
  }
  return v_flex()
    .id("dialog")
    .track_focus(app.handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") {
        closeOverlay(props().overlay);
        cx.stop_propagation();
      }
    })
    .size_full()
    .min_h(0)
    .p(18)
    .bg(t.popover)
    .text_color(t.foreground)
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(d.title ?? TITLES[d.kind] ?? "")).child(div().text_size(11).text_color(t.dim).child("Esc")))
    .child(v_flex().id("dialog-body").flex_1().min_h(0).overflow_y_scrollbar().children(body))
    .when(Boolean(app.error), (el) => el.child(div().pt(10).text_size(12).text_color(toneColor(t, "error")).child(app.error)))
    .child(
      h_flex()
        .pt(14)
        .gap(8)
        .justify_end()
        .child(button(t, "dlg-cancel", primary ? "Cancel" : "Close", "plain", () => closeOverlay(props().overlay)))
        .when(Boolean(primary), (el) => el.child(button(t, "dlg-ok", app.sending ? "Sending…" : primary.label, primary.kind === "danger" ? "destructive" : "primary", (_e, cx) => submit(app, cx), { busy: app.sending }))),
    );
}

