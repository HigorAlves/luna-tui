// The board page: the sidebar (views and projects), the header, and the columns in their three
// groups, Done folded to a rail. Draws from the app's state; clicks change it and notify.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";

import {
  GROUPS, VIEWS, actionsFor, ago, cardId, cardLine, chips, filterTasks, look, plainTitle, projectOf, projects, summary, viewCounts,
} from "./model.js";
import { applyToggles, arrange, flatOrder, getCtl, isFolded, needsStops } from "./controls.js";
import { alpha, button, chip, dot, groupLabel, heading, icon, mono, projectColor, spinner, toneColor } from "./ui.js";
import { PAGES } from "./registry.js";

export const COLUMN_ICON = { Intake: "intake", Triage: "triage", Plan: "plan", Build: "build", Verify: "verify", Evidence: "evidence", Ship: "ship", Done: "done" };
/** A column's width: the open columns share the board's room, between a readable minimum and a
 *  comfortable maximum; below the minimum the board scrolls sideways. */
export function columnWidth(boardWidth, doneOpen, folded = 0) {
  const fixed = 32 + 2 * 14 + 4 * 10 + 14 + (doneOpen ? 0 : 38) + folded * 38;
  const n = Math.max(1, (doneOpen ? 8 : 7) - folded);
  return Math.max(176, Math.min(260, Math.floor((boardWidth - fixed - (doneOpen ? 24 : 0)) / n)));
}

/** The machine's link, as the sidebar's foot says it. */
function linkLine(app, t) {
  const words = { live: "Live", connecting: "Connecting…", offline: "Machine offline", polling: "Polling" }[app.link] ?? app.link;
  const color = app.link === "live" ? t.done : app.link === "offline" ? toneColor(t, "error") : t.dim;
  const where = app.machine.base ? app.machine.base.replace(/^https?:\/\//, "") : "";
  return h_flex()
    .id("link")
    .px(10)
    .h(26)
    .gap(7)
    .items_center()
    .rounded(7)
    .text_size(11)
    .text_color(t.dim)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(app.link === "offline" ? (app.error ?? "The machine does not answer") : "Reload the board")
    .on_click((_e, cx) => app.reload(cx, true))
    .child(dot(color, 7))
    .child(div().text_color(app.link === "offline" ? toneColor(t, "error") : t.muted).child(words))
    .child(div().flex_1())
    .child(div().font_family(mono()).text_size(10.5).child(where));
}

function sideRow(t, id, { label, iconName = null, iconColor = null, count = null, countTone = null, active = false, sub = null, lead = null }, onClick) {
  return h_flex()
    .id(id)
    .px(10)
    .when(Boolean(sub), (el) => el.py(6))
    .when(!sub, (el) => el.h(30))
    .gap(8)
    .items_center()
    .rounded(8)
    .text_size(12.5)
    .cursor_pointer()
    .when(active, (el) => el.bg(t.selected))
    .when(!active, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click(onClick)
    .when(Boolean(lead), (el) => el.child(lead))
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 14, iconColor ?? (active ? t.foreground : t.muted))))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(div().truncate().text_color(active ? t.foreground : t.foreground).when(active, (el) => el.font_medium()).child(label))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))),
    )
    .when(count != null, (el) => el.child(div().flex_none().text_size(11).text_color(countTone ? toneColor(t, countTone) : t.dim).when(Boolean(countTone), (e) => e.font_semibold()).child(String(count))));
}

/** The left sidebar: Board | PRs, search, views, projects, the machine's link and New task. */
export function sidebar(app, t) {
  const now = Date.now();
  const counts = viewCounts(app.tasks, now);
  const badge = (p) => {
    try {
      return p.badge?.(app) ?? null;
    } catch {
      return null;
    }
  };
  const nav = PAGES.filter((p) => !p.hidden).map((p) => {
    const b = badge(p);
    return sideRow(t, `page-${p.id}`, { label: p.label, iconName: p.icon, count: b?.n ?? null, countTone: b?.tone ?? null, active: app.page === p.id }, (_e, cx) => app.go(p.id, cx));
  });
  return v_flex()
    .w(236)
    .flex_none()
    .h_full()
    .min_h(0)
    .bg(t.chrome)
    .border_r(1)
    .border_color(t.border)
    .px(8)
    .pt(10)
    .pb(8)
    .gap(2)
    .child(
      h_flex()
        .mb(6)
        .h(30)
        .px(8)
        .gap(7)
        .items_center()
        .rounded(7)
        .bg(t.background)
        .border_1()
        .border_color(app.searchFocused ? t.accent : t.border)
        .child(icon("search", 13, t.dim))
        .child(Input.new(app.search).flex_1().text_size(12.5).text_color(t.foreground)),
    )
    .children(nav)
    .when(app.page === "board", (el) =>
      el
        .child(heading(t, "Views"))
        .children(
          VIEWS.map((v) =>
            sideRow(
              t,
              `view-${v.id}`,
              {
                label: v.label,
                iconName: v.icon,
                iconColor: v.id === "you" && counts.you ? t.blocked : null,
                count: counts[v.id] || null,
                countTone: v.id === "you" && counts.you ? "blocked" : null,
                active: app.view === v.id && !app.project,
              },
              (_e, cx) => {
                app.view = v.id;
                app.project = null;
                cx.notify();
              },
            ),
          ),
        )
        .child(heading(t, "Projects"))
        .child(
          v_flex()
            .id("projects")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .gap(1)
            .children(
              projects(app.tasks, now).map((p) =>
                sideRow(
                  t,
                  `proj-${p.name}`,
                  {
                    label: p.name,
                    lead: dot(projectColor(t, p.name)),
                    sub: [`${p.open} open`, p.running ? `${p.running} running` : null, p.waiting ? `${p.waiting} waiting` : null].filter(Boolean).join(" · "),
                    active: app.project === p.name,
                    count: null,
                  },
                  (_e, cx) => {
                    app.project = app.project === p.name ? null : p.name;
                    app.view = "all";
                    cx.notify();
                  },
                ),
              ),
            ),
        ),
    )
    .when(app.page !== "board", (el) => el.child(div().flex_1()))
    .child(linkLine(app, t))
    .child(div().h(6))
    .child(button(t, "new-task", "New task", "plain", (_e, cx) => app.newTask(cx), { iconName: "plus" }));
}

/** One card, as the design draws it: id row, title, chips, one line about now. Density and marks change it. */
function card(app, t, task, now, ctl) {
  const l = look(task, now);
  const line = cardLine(task, now);
  const selected = app.selected === task.id;
  const marked = ctl.marked.has(task.id);
  const waiting = l === "needs_you" || l === "escalated";
  const working = l === "working";
  const one = ctl.density === "one";
  // What goes out to GitHub (a review, a release) is decided in the inspector, where it is shown first.
  const quick = task.state === "awaiting_ship" ? null : actionsFor(task, now).find((a) => a.kind === "primary" && ["start", "approve", "resume"].includes(a.id));
  const frame = marked ? t.accent : waiting ? t.blocked : working ? t.working : selected ? t.accent : t.border;
  const click = (e, cx) => {
    if (e?.modifiers?.shift || e?.modifiers?.platform) {
      app.toggleMark(task.id, cx);
      return;
    }
    app.select(task.id, cx);
  };
  const idRow = h_flex()
    .gap(6)
    .items_center()
    .when(marked, (el) => el.child(icon("check", 11, t.accent)))
    .child(dot(projectColor(t, projectOf(task)), 6))
    .child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(cardId(task)))
    .when(one, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(l === "archived" ? t.dim : t.foreground).child(plainTitle(task))))
    .when(one, (el) => el.child(div().flex_none().text_size(10.5).text_color(line.tone ? toneColor(t, line.tone) : t.dim).child(ago(task.updatedAt)?.replace(" ago", "") ?? "")))
    .when(!one, (el) => el.child(div().flex_1()))
    .when(working, (el) => el.child(spinner(t, 11)))
    .when(Boolean(quick) && !working && !one, (el) =>
      el.child(button(t, `quick-${task.id}`, quick.label === "Approve" ? "Approve" : quick.label, "primary", (_e, cx) => app.act(task, quick.id, cx), { small: true, busy: app.busy.has(task.id) })),
    );
  const body = v_flex()
    .id(`card-${task.id}`)
    .w_full()
    .p(one ? 7 : 10)
    .gap(6)
    .rounded(8)
    .bg(selected ? t.selected : marked ? alpha(t.accent, 0.1) : t.background)
    .border(waiting || marked ? 2 : selected || working ? 1.5 : 1)
    .border_color(frame)
    .cursor_pointer()
    .when(!selected, (el) => el.hover((s) => s.border_color(waiting ? t.blocked : t.input)))
    .on_click(click)
    .child(idRow)
    .when(!one, (el) => el.child(div().text_size(12.5).font_medium().text_color(l === "archived" ? t.dim : t.foreground).child(plainTitle(task))))
    .when(ctl.density === "four" && chips(task).length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().children(chips(task).map((c) => chip(t, c.text, c.tone)))))
    .when(!one, (el) => el.child(div().text_size(11).truncate().text_color(line.tone ? toneColor(t, line.tone) : t.dim).child(line.text)));
  if (!waiting || one) return body;
  return v_flex()
    .w_full()
    .pt(7)
    .relative()
    .child(body)
    .child(
      div()
        .absolute()
        .top(0)
        .left(10)
        .px(6)
        .h(15)
        .flex()
        .items_center()
        .rounded(4)
        .bg(t.blocked)
        .text_size(9.5)
        .font_bold()
        .text_color(t.background)
        .child(l === "escalated" ? "Escalated" : "Waiting on you"),
    );
}

/** A folded column: a narrow rail with its icon and count; click to unfold it. */
function rail(app, t, name, tasks, focused) {
  return v_flex()
    .id(`rail-${name}`)
    .w(38)
    .flex_none()
    .mt(30)
    .py(12)
    .gap(8)
    .items_center()
    .rounded(8)
    .bg(t.hover)
    .border_1()
    .border_color(focused ? t.accent : t.hover)
    .cursor_pointer()
    .hover((s) => s.bg(t.raised))
    .tooltip(`Show ${name}`)
    .on_click((_e, cx) => app.unfold(name, cx))
    .child(icon(COLUMN_ICON[name], 15, name === "Done" ? t.done : t.muted))
    .child(div().text_size(11).font_semibold().text_color(t.muted).child(String(tasks.length)));
}

function column(app, t, name, tasks, now, ctl) {
  const focused = ctl.focus === name;
  return v_flex()
    .w(app.columnW ?? 200)
    .flex_none()
    .h_full()
    .min_h(0)
    .gap(6)
    .child(
      h_flex()
        .id(`colhead-${name}`)
        .h(24)
        .px(4)
        .gap(6)
        .items_center()
        .text_size(11.5)
        .font_semibold()
        .text_color(focused ? t.foreground : t.muted)
        .border_b(2)
        .border_color(focused ? t.accent : t.canvas)
        .cursor_pointer()
        .on_click((_e, cx) => app.focusColumn(name, cx))
        .child(icon(COLUMN_ICON[name], 12, focused ? t.accent : t.dim))
        .child(name)
        .child(div().font_normal().text_color(t.dim).child(String(tasks.length))),
    )
    .child(
      v_flex()
        .id(`col-${name}`)
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .gap(7)
        .pr(2)
        .children(tasks.map((task) => card(app, t, task, now, ctl)))
        .when(tasks.length === 0, (el) => el.child(div().h(56).rounded(8).border_1().border_dashed().border_color(t.border))),
    );
}

/** The board page's header: the view's name and a summary line, then refresh and New task. */
function header(app, t, shown, ctl) {
  const viewName = app.project ?? VIEWS.find((v) => v.id === app.view)?.label ?? "Everything";
  const marks = ctl.marked.size;
  const notes = [
    ctl.needsOnly ? "only what needs you" : null,
    ctl.thisRepo ? `only ${ctl.thisRepo.split("/").pop()}` : null,
    app.query?.trim() ? `“${app.query.trim()}”` : null,
    ctl.group !== "stage" ? `by ${ctl.group}` : null,
  ].filter(Boolean);
  const hint = ctl.prefix ? (ctl.prefix.c === "g" ? "g ▸  g first · s stage · r repo · a age" : "z ▸  c fold · o unfold · z fold the others") : null;
  return h_flex()
    .h(56)
    .flex_none()
    .px(16)
    .gap(10)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(
      v_flex()
        .min_w(0)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(viewName))
        .child(div().text_size(11).text_color(t.dim).truncate().child([summary(shown), ...notes].join(" · "))),
    )
    .when(marks > 0, (el) => el.child(chip(t, `${marks} marked · a X d w Z · esc clears`, "accent", 11)))
    .when(Boolean(hint), (el) => el.child(chip(t, hint, null, 11)))
    .child(div().flex_1())
    .when(Boolean(app.flash), (el) => el.child(div().max_w(420).truncate().text_size(11.5).text_color(app.flash.tone ? toneColor(t, app.flash.tone) : t.muted).child(app.flash.text)))
    .child(button(t, "palette", ":", "quiet", (_e, cx) => app.palette(cx), { small: true }))
    .child(button(t, "refresh", "", "quiet", (_e, cx) => app.reload(cx, true), { iconName: "refresh" }))
    .child(button(t, "header-new", "New task", "primary", (_e, cx) => app.newTask(cx), { iconName: "plus" }));
}

/** The board page: header and the grouped columns, scrolling sideways when the pane is narrow. */
export function boardPage(app, t) {
  const now = Date.now();
  const ctl = getCtl(app);
  const kept = applyToggles(filterTasks(app.tasks, { view: app.view, project: app.project, query: app.query }, now), ctl, now);
  const by = arrange(kept, ctl.group, now);
  // The focused column follows a card chosen any other way (a click, the inbox folder).
  const sel = app.selected ? app.tasks.find((x) => x.id === app.selected) : null;
  if (sel && ctl.syncedSel !== sel.id) {
    ctl.syncedSel = sel.id;
    if (by[sel.column]) ctl.focus = sel.column;
  } else if (!sel) ctl.syncedSel = null;
  const done = Boolean(app.doneOpen);
  const doneOpen = !isFolded(ctl, "Done", done);
  const foldedOpen = GROUPS.flatMap((g) => g.columns).filter((c) => isFolded(ctl, c, done)).length;
  app.columnW = columnWidth(app.boardWidth ?? 1200, doneOpen, foldedOpen);
  // What the keys walk: each open column's ids as drawn, and the flat order for next/prev.
  app.cols = Object.fromEntries(Object.entries(by).map(([c, list]) => [c, isFolded(ctl, c, done) ? [] : list.map((x) => x.id)]));
  app.allCols = Object.fromEntries(Object.entries(by).map(([c, list]) => [c, list.map((x) => x.id)]));
  app.order = flatOrder(app.cols, ctl, done);
  app.stops = needsStops(app.allCols, app.tasks, now);
  const empty = app.loaded && app.tasks.length === 0;
  const draw = (c) => (isFolded(ctl, c, done) ? rail(app, t, c, by[c], ctl.focus === c) : column(app, t, c, c === "Done" ? by[c].slice(0, 40) : by[c], now, ctl));
  return v_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .bg(t.canvas)
    .child(header(app, t, kept, ctl))
    .when(!app.loaded, (el) => el.child(h_flex().flex_1().items_center().justify_center().gap(8).text_color(t.dim).child(spinner(t, 14)).child(app.error ?? "Reading the board…")))
    .when(empty, (el) =>
      el.child(
        v_flex()
          .flex_1()
          .items_center()
          .justify_center()
          .gap(10)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("No tasks yet"))
          .child(div().text_size(12.5).text_color(t.dim).child("New task puts one in Intake; the PR inbox makes review cards."))
          .child(button(t, "empty-new", "New task", "primary", (_e, cx) => app.newTask(cx), { iconName: "plus" })),
      ),
    )
    .when(app.loaded && !empty, (el) =>
      el.child(
        h_flex()
          .id("board")
          .flex_1()
          .min_h(0)
          .overflow_x_scrollbar()
          .px(16)
          .pt(12)
          .pb(10)
          .gap(14)
          .items_start()
          .children(
            GROUPS.map((g) =>
              v_flex()
                .flex_none()
                .h_full()
                .min_h(0)
                .gap(8)
                .child(div().pb(5).border_b(1).border_color(t.border).child(groupLabel(t, g.name)))
                .child(h_flex().flex_1().min_h(0).gap(10).children(g.columns.map(draw))),
            ),
          )
          .child(
            doneOpen
              ? v_flex().flex_none().h_full().min_h(0).gap(8).child(div().pb(5).border_b(1).border_color(t.border).child(groupLabel(t, "Done"))).child(draw("Done"))
              : draw("Done"),
          ),
      ),
    );
}
