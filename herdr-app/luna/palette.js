// The command palette (`:`) and the board's own commands. The palette is a dialog: an input over a
// list of entries (the TUI's commands, the registered PALETTE entries and every COMMANDS verb).
// Enter hands the line back to the board (`setShared("luna.command", {line, at})`), and
// takeShared runs it through `inboxCommand`, the same path as the inbox folder.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { Input, InputState } from "gpui-base";
import { setShared } from "herdr";

import { foldFocused, setGroup } from "./boardkeys.js";
import { GROUP_BY, keyName, matchEntries, paletteEntries, resolveLine } from "./controls.js";
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

COMMANDS.start = (app, _arg, cx) => {
  const task = app.tasks.find((t) => t.id === app.selected);
  if (!task) app.say("no ticket selected", "error");
  else if (task.state !== "draft") app.say("only a draft starts", "error");
  else return app.act(task, "start", cx);
  cx.notify();
};

COMMANDS.slots = (app, arg, cx) => {
  const n = Number.parseInt(String(arg ?? ""), 10);
  if (!(n >= 1)) {
    app.say("slots takes a number, e.g. :slots 3", "error");
    return cx.notify();
  }
  app.run(cx, "pool", `${n} slot${n === 1 ? "" : "s"}`, () => app.machine.patch("/slots", { max: n }));
};

COMMANDS.drain = (app, _arg, cx) => app.run(cx, "pool", "Taking no new work: running stages finish", () => app.machine.post("/drain"));
COMMANDS.resume = (app, _arg, cx) => app.run(cx, "pool", "Carrying on: the queue is picked up again", () => app.machine.post("/resume"));

COMMANDS.help = (app) => app.keysSheet();
COMMANDS.keys = (app) => app.keysSheet();

/** `palette <id>`: runs a registered PALETTE entry on the board. */
COMMANDS.palette = (app, arg, cx) => {
  const entry = PALETTE.find((p) => p.id === String(arg ?? "").trim());
  if (entry) entry.run(app, cx);
  else app.say(`no command ${arg}`, "error");
};

// ---- the dialog ----

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
  if (r.action === "run") setShared("luna.command", { line: r.line, at: Date.now() });
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
