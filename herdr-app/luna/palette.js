// The command palette (`:`) and the board's own commands. The palette is a dialog: an input over a
// list of entries (the TUI's commands, the registered PALETTE entries and every COMMANDS verb).
// Enter hands the line back to the board (`setShared("luna.command", {line, at})`), and
// takeShared runs it through `inboxCommand`, the same path as the inbox folder.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { Input, InputState } from "gpui-base";

import { dismissBody, findingBody, segment } from "./actions-rules.js";
import { foldFocused, setGroup } from "./boardkeys.js";
import { GROUP_BY, heldReason, keyName, matchEntries, paletteEntries, rejectKind, resolveLine } from "./controls.js";
import { encodeKey, waitingDrafts } from "./views-model.js";
import { boxed, finish } from "./dialogs.js";
import { COMMANDS, DIALOGS, PALETTE } from "./registry.js";
import { mono } from "./ui.js";

// ---- the commands the board runs itself ----

COMMANDS.new = (app, arg) => {
  const repos = [...new Set(app.tasks.map((t) => t.repoPath).filter(Boolean))];
  const current = app.tasks.find((t) => t.id === app.selected)?.repoPath ?? repos[0] ?? "";
  app.dialog({ kind: "new_task", repos, repoPath: current, title: arg ?? "" }, 600, 520);
};

COMMANDS.filter = (app, arg, cx) => {
  app.query = arg ?? "";
  try {
    app.search?.set_value?.(app.query);
  } catch {
    // the query is set; the box catches up on the next typing
  }
  app.go("board", cx);
};

COMMANDS.open = (app, arg, cx) => {
  const want = String(arg ?? "").replace(/^#/, "").trim();
  const task = want ? app.tasks.find((t) => t.id.startsWith(want) || t.jira?.key === want.toUpperCase()) : null;
  if (!task) {
    app.say(`no ticket starts with #${want}`, "error");
    return cx.notify();
  }
  app.go("board", cx);
  app.select(task.id, cx);
};

COMMANDS.group = (app, arg, cx) => {
  const id = String(arg ?? "").trim();
  if (!GROUP_BY.some((g) => g.id === id)) {
    app.say("group takes stage, repo or age", "error");
    return cx.notify();
  }
  setGroup(app, id, cx);
};

COMMANDS.fold = (app, _arg, cx) => foldFocused(app, "c", cx);
COMMANDS.unfold = (app, _arg, cx) => foldFocused(app, "o", cx);

const enc = encodeURIComponent;
const fail = (app, text, cx) => {
  app.say(text, "error");
  cx.notify();
};
const selectedTask = (app) => app.tasks.find((t) => t.id === app.selected) ?? null;
/** The selected ticket, or says there is none. */
const need = (app, cx) => {
  const task = selectedTask(app);
  if (!task) fail(app, "no ticket selected", cx);
  return task;
};

/** `:start` is `a`: start, resume, approve (asks), answer, retry; a held draft says why it waits. */
COMMANDS.start = (app, _arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const why = heldReason(task, app.details?.[task.id]);
  if (why) return fail(app, `held: ${why}`, cx);
  app.primary(cx);
};

COMMANDS.refresh = (app, _arg, cx) => app.reload(cx, true);
COMMANDS.reload = COMMANDS.refresh;

/** `:repo <name>`: the one known repo whose path holds the name; a path as given when it starts with `/`, `~` or `.`; bare opens the search. */
COMMANDS.repo = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const name = String(arg ?? "").trim();
  if (!name) return app.act(task, "set_repo", cx);
  const set = (cx, repoPath) => app.run(cx, task.id, `Repo set to ${repoPath}`, () => app.machine.patch(`/tasks/${enc(task.id)}`, { repoPath }));
  if (/^[/~.]/.test(name)) return set(cx, name);
  cx.spawn(async (cx2) => {
    let known = [];
    try {
      known = ((await app.machine.get("/repos")) ?? []).map((r) => r.repo).filter(Boolean);
    } catch {
      // the repos already on the board still count
    }
    const paths = [...new Set([...known, ...app.tasks.map((t) => t.repoPath).filter(Boolean)])];
    const hits = paths.filter((p) => p.toLowerCase().includes(name.toLowerCase()));
    if (!hits.length) return fail(app, `no repo holds "${name}"`, cx2);
    if (hits.length > 1) return fail(app, `"${name}" holds more than one repo: ${hits.slice(0, 4).join(", ")}`, cx2);
    set(cx2, hits[0]);
  });
};

/** `:whole`: approve and keep the card as one instead of splitting it. */
COMMANDS.whole = (app, _arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  if (rejectKind(task, app.details?.[task.id]) !== "plan") return fail(app, "keep whole answers a plan or split gate; this card is not at one", cx);
  app.act(task, "keep_whole", cx);
};

/** `:dismiss <finding id> [reason]`. */
COMMANDS.dismiss = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const [id, ...rest] = String(arg ?? "").trim().split(/\s+/);
  if (!id) return fail(app, "dismiss takes a finding id, e.g. :dismiss f3 not a bug", cx);
  const body = dismissBody(rest.join(" ").slice(0, 500));
  app.run(cx, task.id, "finding dismissed", () => app.machine.post(`/tasks/${enc(task.id)}/findings/${segment(id)}/dismiss`, body));
};

/** `:finding <blocker|should_fix|nit> <title>`. */
COMMANDS.finding = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const [severity, ...rest] = String(arg ?? "").trim().split(/\s+/);
  const title = rest.join(" ").trim();
  if (!["blocker", "should_fix", "nit"].includes(severity)) return fail(app, "finding takes blocker, should_fix or nit, then a title", cx);
  if (!title) return fail(app, "finding: give it a title", cx);
  app.run(cx, task.id, "finding added", () => app.machine.post(`/tasks/${enc(task.id)}/findings`, findingBody({ severity, title })));
};

/** `:ticket-edit <text>`: your text is posted in place of the selected ticket's waiting draft (the Tickets page's selection). */
COMMANDS["ticket-edit"] = (app, arg, cx) => {
  const st = app.state("tickets");
  const ticket = (st.items ?? []).find((t) => t.key === st.selected);
  if (!ticket) return fail(app, "open the Tickets view and select a ticket first", cx);
  const draft = waitingDrafts(ticket)[0];
  if (!draft) return fail(app, "no draft waiting on it", cx);
  const text = String(arg ?? "").trim();
  if (!text) return fail(app, "say what to post: :ticket-edit <text>", cx);
  if (text.length > 1500) return fail(app, "your text is over 1500 characters", cx);
  app.run(cx, `tk-${ticket.key}`, "posted your text", () => app.machine.post(`/tickets/${encodeKey(ticket.key)}/edit`, { draft: draft.id, hash: draft.hash, text }));
};

/** `:dedup duplicate <slot> | related <slots> | neither`: the answer to Intake's duplicate question. */
COMMANDS.dedup = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const open = [...(app.details?.[task.id]?.approvals ?? [])].reverse().find((a) => !a.decision);
  const listed = open?.requested?.candidates ?? [];
  if (!listed.length) return fail(app, "this ticket is not waiting on a duplicate question (open its detail first)", cx);
  const [choice, ...slots] = String(arg ?? "").trim().split(/\s+/);
  const ids = [];
  for (const part of slots.join(" ").split(",").map((x) => x.trim()).filter(Boolean)) {
    const hit = listed.find((c) => String(c.slot) === part);
    if (!/^\d+$/.test(part)) return fail(app, `${part} is not a slot number`, cx);
    if (!hit) return fail(app, `no candidate in slot ${part}`, cx);
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  if (choice === "neither") return app.run(cx, task.id, "answered", () => app.machine.dedup(task.id, "neither", []));
  if (choice === "duplicate") {
    if (ids.length !== 1) return fail(app, "name exactly one slot: :dedup duplicate 2", cx);
    return app.run(cx, task.id, "answered", () => app.machine.dedup(task.id, "duplicate", ids));
  }
  if (choice === "related") {
    if (!ids.length) return fail(app, "name the slots: :dedup related 1,3", cx);
    return app.run(cx, task.id, "answered", () => app.machine.dedup(task.id, "related", ids));
  }
  fail(app, "use :dedup duplicate <slot> | related <slots> | neither", cx);
};

/** `:dup <id prefix>`: the selected ticket is a duplicate of that one (the prefix is at least 4 characters and names one). */
COMMANDS.dup = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const prefix = String(arg ?? "").trim().replace(/^#/, "");
  if (prefix.length < 4) return fail(app, "dup takes at least 4 characters of the other ticket's id", cx);
  const hits = app.tasks.filter((t) => t.id !== task.id && t.id.startsWith(prefix));
  if (!hits.length) return fail(app, `no ticket starts with ${prefix}`, cx);
  if (hits.length > 1) return fail(app, `${prefix} starts more than one ticket`, cx);
  app.run(cx, task.id, "merged: it closes as a duplicate", () => app.machine.post(`/tasks/${enc(task.id)}/merge`, { into: hits[0].id }));
};

/** `:undup`: the selected, merged ticket comes back as a new card. */
COMMANDS.undup = (app, _arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  if (!task.mergedInto) return fail(app, "this ticket was not merged into another", cx);
  app.run(cx, task.id, "unmerged: it is a new card", () => app.machine.post(`/tasks/${enc(task.id)}/unmerge`, {}));
};

/** `:context repo|project|text <value>`: what Intake's gate asked for. */
COMMANDS.context = (app, arg, cx) => {
  const task = need(app, cx);
  if (!task) return;
  const [field, ...rest] = String(arg ?? "").trim().split(/\s+/);
  const key = { repo: "repoPath", project: "project", text: "text" }[field];
  if (!key) return fail(app, "use :context repo|project|text <value>", cx);
  const value = rest.join(" ").trim();
  if (!value) return fail(app, `${field}: give a value`, cx);
  app.run(cx, task.id, "Intake checked the ticket again", () => app.machine.context(task.id, { [key]: value }));
};

// `:jira <KEY>` is the Jira page's (page-jira.js registers COMMANDS.jira); the palette only routes it.

// `slots`, `drain` and `resume` are the Floor's (page-floor.js): they ask first.

COMMANDS.help = (app) => app.keysSheet();
COMMANDS.keys = (app) => app.keysSheet();

/** `palette <id>`: runs a registered PALETTE entry on the board. */
COMMANDS.palette = (app, arg, cx) => {
  const entry = PALETTE.find((p) => p.id === String(arg ?? "").trim());
  if (entry) entry.run(app, cx);
  else app.say(`no command ${arg}`, "error");
};

// ---- the dialog ----

/** The verbs the board itself understands beyond COMMANDS (the inbox folder's: `select`, `tab`, `act`, ...). */
const KNOWN = new Set(["select", "tab", "list", "act", "page", "done", "focus", "next", "prev", "close", "search", "approve"]);

const entriesOf = () => paletteEntries(PALETTE, Object.keys(COMMANDS).filter((v) => v !== "palette" && v !== "page"));
const matches = (app) => matchEntries(app.base ?? app.line, app.entries);

function run(app, cx) {
  const m = matches(app);
  const r = resolveLine(app.line, app.pick != null ? m[app.pick] ?? null : null, m);
  if (r.action === "complete") {
    app.line = r.line;
    app.cmd.set_value(r.line);
    app.pick = null;
    return cx.notify();
  }
  if (r.action === "run") {
    const verb = r.line.split(/\s+/)[0];
    if (!KNOWN.has(verb) && !COMMANDS[verb]) {
      app.error = `unknown command: ${verb} (try :help)`;
      return cx.notify();
    }
    app.handBack("command", { line: r.line });
  }
  finish(app);
}

DIALOGS.palette = {
  title: "Command",
  height: 440,
  width: 560,
  init(app, cx) {
    app.entries = entriesOf();
    app.line = "";
    app.pick = null;
    app.cmd = InputState.new({ placeholder: "new, filter, open, group, fold, slots … (tab completes)" });
    app.cmd.on("change", (_e, cx) => {
      app.line = app.cmd.value();
      // A tab's own completion is not typing: the list it cycles stays.
      if (app.completed === app.line) return;
      app.base = null;
      app.pick = null;
      cx.notify();
    });
    app.cmd.on("submit", (_e, cx) => run(app, cx));
    app.cmd.focus();
    cx.timer.after(400, () => app.cmd.focus());
  },
  body: (app, t) => {
    const list = matches(app);
    const out = [boxed(t, Input.new(app.cmd).w_full())];
    if (!list.length) out.push(div().pt(12).text_size(12).text_color(t.dim).child("No command starts with that: Enter runs the text as typed."));
    list.slice(0, 40).forEach((e, i) => {
      out.push(
        h_flex()
          .id(`pal-${i}`)
          .gap(8)
          .h(28)
          .px(8)
          .mt(i === 0 ? 8 : 0)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .when(app.pick === i, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            app.pick = i;
            run(app, cx);
          })
          .child(div().flex_none().font_family(mono()).text_size(12).text_color(t.accent).child(`:${e.name}`))
          .child(div().flex_none().font_family(mono()).text_size(11).text_color(t.dim).child(e.arg ?? ""))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(e.does)),
      );
    });
    return out;
  },
  primary: () => ({ label: "Run", kind: "primary" }),
  submit: (app, cx) => run(app, cx),
  key(app, e, cx) {
    const k = keyName(e);
    const n = Math.min(matches(app).length, 40);
    if (k === "down" || k === "ctrl-n") app.pick = n ? Math.min(n - 1, (app.pick ?? -1) + 1) : null;
    else if (k === "up" || k === "ctrl-p") app.pick = app.pick > 0 ? app.pick - 1 : null;
    else if (k === "tab") {
      app.base ??= app.line;
      const m = matches(app);
      if (!m.length) return true;
      app.pick = app.pick == null ? 0 : (app.pick + 1) % Math.min(m.length, 40);
      const e0 = m[app.pick];
      app.line = `${e0.name}${e0.arg ? " " : ""}`;
      app.completed = app.line;
      app.cmd.set_value(app.line);
    } else return false;
    cx.notify();
    return true;
  },
};
