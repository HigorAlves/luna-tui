// The inspector beside the board: the task's header, what it waits on (the gate, with its
// actions), then Details, Activity, Runs and Changes. The task comes from the board's list (live);
// the rest from `GET /tasks/:id`, read again when the task changes.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";

import { actionsFor, ago, cardId, cardLine, duration, ended, escalationWords, gateQuestion, look, money, plainTitle, projectOf, stageWords } from "./model.js";
import { COLUMN_ICON } from "./board.js";
import { alpha, button, chip, dot, fact, icon, mono, projectColor, spinner, toneColor } from "./ui.js";
import { MORE, TABS, tab as addTab } from "./registry.js";

const text = (v) => (typeof v === "string" ? v : v?.text ?? v?.question ?? v?.title ?? v?.description ?? (v == null ? "" : JSON.stringify(v)));

export function sub(t, label, extra = null) {
  return h_flex().pt(10).pb(4).gap(8).items_center().child(div().text_size(12).font_semibold().text_color(t.muted).child(label)).when(extra != null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(extra)));
}

export function bullet(t, body, { tone = null, mark = "•" } = {}) {
  return h_flex()
    .gap(8)
    .items_start()
    .text_size(12.5)
    .child(div().w(12).flex_none().text_color(tone ? toneColor(t, tone) : t.dim).child(mark))
    .child(div().flex_1().min_w(0).text_color(t.foreground).child(body));
}

export function markdown(id, body) {
  return TextView.markdown(id, body).selectable(true);
}

export function codeBlock(t, body) {
  return div().p(8).rounded(7).bg(t.background).border_1().border_color(t.border).font_family(mono()).text_size(11).text_color(t.muted).child(body);
}

/** The gate's own content: the plan, the questions, the release checklist, the review to post, or the escalation. */
export function gateBody(t, task) {
  const r = task.gate?.requested ?? {};
  const parts = [];
  if (task.state === "escalated") {
    if (r.summary) parts.push(div().text_size(12.5).text_color(t.foreground).child(String(r.summary)));
    const tail = r.outputTail ?? null;
    if (tail) parts.push(codeBlock(t, String(tail).slice(-1200)));
    return parts;
  }
  if (task.state === "awaiting_approval") {
    if (r.risk?.level) parts.push(h_flex().gap(6).child(chip(t, `${r.risk.level} risk`, r.risk.level === "high" ? "error" : r.risk.level === "medium" ? "blocked" : null)).child(div().flex_1().text_size(11.5).text_color(t.dim).truncate().child(r.risk.reason ?? "")));
    if (r.brief) parts.push(markdown(`brief-${task.id}`, String(r.brief)));
    const steps = r.steps ?? r.slices ?? [];
    if (steps.length) {
      parts.push(sub(t, "Steps", String(steps.length)));
      steps.forEach((s, i) => parts.push(bullet(t, `${text(s)}${s.est_loc ? `  ·  ~${s.est_loc} lines` : ""}`, { mark: `${i + 1}` })));
    }
    const gaps = r.coverageReport?.gaps ?? r.gaps ?? [];
    if (gaps.length) parts.push(div().text_size(11.5).text_color(t.blocked).child(`${gaps.length} criteria no test covers: approve excusing them, or send it back`));
    if (r.split?.children?.length) {
      parts.push(sub(t, "Split into", String(r.split.children.length)));
      r.split.children.forEach((c, i) => parts.push(bullet(t, text(c), { mark: `${i + 1}` })));
    }
    if (r.outcome === "conversation" && r.reply) parts.push(markdown(`reply-${task.id}`, String(r.reply)));
    if (r.outcome === "archive" && r.reason) parts.push(div().text_size(12.5).text_color(t.foreground).child(String(r.reason)));
    return parts;
  }
  if (task.state === "awaiting_answers") {
    (r.questions ?? []).forEach((q, i) => parts.push(bullet(t, text(q), { mark: `${i + 1}` })));
    return parts;
  }
  if (task.state === "awaiting_test_check") {
    (r.cases ?? []).forEach((c, i) => parts.push(bullet(t, `${c.title ?? text(c)}${c.criterion ? `  ·  ${c.criterion}` : ""}`, { mark: `${i + 1}` })));
    return parts;
  }
  if (task.state === "awaiting_ship") {
    const post = r.pr_review_post;
    if (post) {
      const verdict = { APPROVE: ["Approve", "done"], REQUEST_CHANGES: ["Request changes", "error"], COMMENT: ["Comment", null] }[post.event] ?? [post.event, null];
      parts.push(h_flex().gap(6).items_center().child(div().text_size(11.5).text_color(t.dim).child("Verdict")).child(chip(t, verdict[0], verdict[1], 11)).child(div().text_size(11.5).text_color(t.dim).child(`${post.comments?.length ?? 0} line comments · nothing posted yet`)));
      if (post.body) parts.push(markdown(`review-${task.id}`, String(post.body)));
      (post.comments ?? []).slice(0, 15).forEach((c, i) =>
        parts.push(
          v_flex()
            .id(`rc-${i}`)
            .gap(3)
            .p(8)
            .rounded(7)
            .bg(t.hover)
            .child(div().font_family(mono()).text_size(10.5).text_color(t.accent).child(`${c.path}:${c.line}`))
            .child(div().text_size(12).text_color(t.foreground).child(String(c.body ?? ""))),
        ),
      );
      return parts;
    }
    const checklist = r.checklist ?? [];
    checklist.forEach((c) => parts.push(bullet(t, `${c.id ?? ""}${c.detail ? `: ${c.detail}` : ""}`, { tone: c.ok ? "done" : "error", mark: c.ok ? "✓" : "✗" })));
    if (r.evidence?.summary) parts.push(markdown(`ev-${task.id}`, String(r.evidence.summary)));
    if (r.prUrl) parts.push(div().text_size(11.5).text_color(t.accent).child(String(r.prUrl)));
    return parts;
  }
  if (task.state === "awaiting_setup" && r.kind === "dedup") {
    (r.candidates ?? []).forEach((c) => parts.push(bullet(t, `${c.title} · ${c.state}${c.score ? ` · ${Math.round(c.score * 100)}%` : ""}`)));
    return parts;
  }
  if (task.state === "awaiting_setup" && r.kind === "context") {
    parts.push(div().text_size(12.5).text_color(t.foreground).child(`It needs: ${(r.missing ?? []).join(", ") || "more context"}`));
    return parts;
  }
  if (r.yaml ?? r.config) parts.push(codeBlock(t, String(r.yaml ?? r.config).slice(0, 2000)));
  return parts;
}

/** The status strip and, when the task waits on you, the gate with its actions. */
function gatePanel(app, t, task) {
  const now = Date.now();
  const l = look(task, now);
  const line = cardLine(task, now);
  const waiting = l === "needs_you" || l === "escalated";
  const color = line.tone ? toneColor(t, line.tone) : t.border;
  const actions = actionsFor(task, now);
  const busy = app.busy.has(task.id);
  const lead = l === "working" ? spinner(t, 15) : waiting ? icon(l === "escalated" ? "alert" : "hand", 15, t.blocked) : ended(task) ? icon("done", 15, t.done) : icon("clock", 15, t.dim);
  const title = waiting ? (l === "escalated" ? `Escalated: ${escalationWords(task.gate?.requested?.escalationDecision?.reason ?? task.reason ?? "other")}` : gateQuestion(task) ?? "Waiting on you") : line.text;
  const body = waiting ? gateBody(t, task) : [];
  const extra = MORE.filter((m) => {
    try {
      return m.when(task, app);
    } catch {
      return false;
    }
  });
  return v_flex()
    .gap(8)
    .p(12)
    .rounded(10)
    .bg(t.background)
    .border(waiting ? 1.5 : 1)
    .border_color(waiting ? color : t.border)
    .child(
      h_flex()
        .gap(9)
        .items_center()
        .child(lead)
        .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(waiting ? t.foreground : t.muted).child(title))
        .when(task.spentUsd != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(money(task.spentUsd)))),
    )
    .children(body)
    .when(actions.length > 0 || extra.length > 0, (el) =>
      el.child(
        h_flex()
          .pt(4)
          .gap(6)
          .flex_wrap()
          .children(actions.map((a) => button(t, `act-${a.id}`, a.label, a.kind, (_e, cx) => app.act(task, a.id, cx), { busy, small: false })))
          .when(extra.length > 0, (row) =>
            row.child(
              button(t, "act-more", app.moreOpen ? "Less" : "More", "quiet", (_e, cx) => {
                app.moreOpen = !app.moreOpen;
                cx.notify();
              }, { iconName: app.moreOpen ? "chevron-down" : "chevron-right" }),
            ),
          ),
      ),
    )
    .when(app.moreOpen && extra.length > 0, (el) =>
      el.child(
        h_flex()
          .pt(2)
          .gap(6)
          .flex_wrap()
          .children(extra.map((m) => button(t, `more-${m.id}`, m.label, m.kind ?? "plain", (_e, cx) => app.act(task, m.id, cx), { busy, small: true }))),
      ),
    );
}

function details(app, t, task, detail) {
  const kv = [
    ["Stage", stageWords(task.state)],
    ["Column", task.column],
    ["Project", projectOf(task)],
    ["Route", task.route],
    ["Branch", task.branch],
    ["Spent", money(task.spentUsd)],
    ["Worked", duration(task.workedMs)],
    ["Jira", task.jira?.key ?? null],
    ["Priority", task.classification?.priority ?? null],
    ["Updated", ago(task.updatedAt)],
  ].filter(([, v]) => v);
  const criteria = task.criteria ?? [];
  const last = task.lastRun;
  return v_flex()
    .gap(4)
    .child(h_flex().flex_wrap().children(kv.map(([k, v]) => div().w_1_2().child(fact(t, k, v, { monoValue: k === "Branch" || k === "Jira" })))))
    .when(Boolean(last?.summary), (el) => el.child(sub(t, "Last run", `${stageWords(last.stage)} · ${last.outcome}`)).child(div().text_size(12.5).text_color(t.foreground).child(String(last.summary).slice(0, 600))))
    .when(criteria.length > 0, (el) => el.child(sub(t, "Acceptance criteria", String(criteria.length))).children(criteria.map((c, i) => bullet(t, text(c), { mark: `${i + 1}` }))))
    .when(Boolean(task.description), (el) => el.child(sub(t, "Description")).child(markdown(`desc-${task.id}`, String(task.description))))
    .when(Boolean(detail?.ship?.pr?.url), (el) => el.child(sub(t, "Pull request")).child(button(t, "open-pr", `#${detail.ship.pr.number} on GitHub`, "plain", () => app.openUrl(detail.ship.pr.url), { iconName: "external", small: true })));
}

function eventText(e) {
  const p = e.payload ?? {};
  const said = p.summary ?? p.reason ?? p.message ?? p.why ?? p.verdict ?? p.status ?? null;
  const kind = e.kind.replace(/^stage\./, "").replaceAll(".", " ").replaceAll("_", " ");
  return said ? `${kind}: ${typeof said === "string" ? said : JSON.stringify(said)}` : kind;
}

function activity(t, detail) {
  const events = [...(detail?.events ?? [])].reverse().slice(0, 80);
  if (!events.length) return div().text_size(12).text_color(t.dim).child(detail ? "Nothing yet." : "Reading…");
  return v_flex().gap(1).children(
    events.map((e) =>
      h_flex()
        .gap(10)
        .items_start()
        .py(4)
        .child(div().w(54).flex_none().text_size(10.5).text_color(t.dim).child(ago(e.at)?.replace(" ago", "") ?? ""))
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(eventText(e).slice(0, 400))),
    ),
  );
}

function runs(t, detail) {
  const list = [...(detail?.stageRuns ?? [])].reverse().slice(0, 60);
  if (!list.length) return div().text_size(12).text_color(t.dim).child(detail ? "No stage ran yet." : "Reading…");
  const glyph = { passed: ["✓", "done"], failed: ["✗", "error"], running: ["◐", "working"] };
  return v_flex().gap(2).children(
    list.map((r) => {
      const [g, tone] = glyph[r.status] ?? ["·", null];
      const took = r.endedAt && r.startedAt ? duration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : r.status === "running" ? "running" : null;
      return h_flex()
        .gap(8)
        .items_center()
        .h(26)
        .child(div().w(12).text_color(tone ? toneColor(t, tone) : t.dim).child(g))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${stageWords(r.stage)}${r.attempt > 1 ? ` · try ${r.attempt}` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child([r.engine, took, money(r.costUsd)].filter(Boolean).join(" · ")));
    }),
  );
}

function changes(app, t, task) {
  const d = app.diffs[task.id];
  if (!d) return div().text_size(12).text_color(t.dim).child("Reading…");
  if (d.error) return div().text_size(12).text_color(t.dim).child(d.error);
  const status = { A: ["added", "done"], D: ["deleted", "error"], M: ["", null], R: ["renamed", null] };
  return v_flex()
    .gap(1)
    .child(div().pb(6).text_size(11.5).text_color(t.dim).child(`${d.files.length} files against ${d.base}`))
    .children(
      d.files.map((f) =>
        h_flex()
          .id(`file-${f.path}`)
          .gap(8)
          .h(24)
          .px(6)
          .items_center()
          .rounded(6)
          .hover((s) => s.bg(t.hover))
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(f.path))
          .when(Boolean(status[f.status]?.[0]), (el) => el.child(chip(t, status[f.status][0], status[f.status][1])))
          .child(div().text_size(11).text_color(t.done).child(`+${f.added}`))
          .child(div().text_size(11).text_color(toneColor(t, "error")).child(`−${f.removed}`)),
      ),
    );
}

/** The inspector pane for the selected task, or nothing. */
export function inspector(app, t, width) {
  const task = app.tasks.find((x) => x.id === app.selected);
  if (!task) return null;
  const detail = app.details[task.id];
  const tab = TABS.some((x) => x.id === app.tab) ? app.tab : TABS[0]?.id;
  const current = TABS.find((x) => x.id === tab);
  const countOf = (x) => {
    try {
      return x.count?.(app, task, detail) ?? null;
    } catch {
      return null;
    }
  };
  return v_flex()
    .w(width)
    .flex_none()
    .h_full()
    .min_h(0)
    .bg(t.surface ?? t.chrome)
    .border_l(1)
    .border_color(t.border)
    .child(
      v_flex()
        .px(16)
        .pt(12)
        .pb(12)
        .gap(9)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .text_size(11.5)
            .text_color(t.dim)
            .child(div().font_family(mono()).font_semibold().text_color(t.foreground).child(cardId(task)))
            .child(h_flex().gap(5).items_center().child(dot(projectColor(t, projectOf(task)), 6)).child(projectOf(task)))
            .child(div().flex_1())
            .child(button(t, "close-inspector", "", "quiet", (_e, cx) => app.select(null, cx), { iconName: "close", small: true })),
        )
        .child(div().text_size(16).font_bold().text_color(t.foreground).child(plainTitle(task)))
        .child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(h_flex().gap(5).px(8).h(22).items_center().rounded(7).border_1().border_color(t.border).text_size(11.5).text_color(t.foreground).child(icon(COLUMN_ICON[task.column] ?? "board", 11, t.muted)).child(task.column))
            .when(Boolean(task.jira?.key), (el) => el.child(chip(t, task.jira.key, "accent", 11)))
            .when(task.route !== "feature", (el) => el.child(chip(t, task.route, null, 11)))
            .when(Boolean(task.classification?.priority), (el) => el.child(chip(t, task.classification.priority, ["P0", "P1"].includes(task.classification.priority) ? "error" : null, 11))),
        )
        .child(gatePanel(app, t, task)),
    )
    .child(
      h_flex()
        .px(16)
        .gap(16)
        .h(36)
        .id("inspector-tabs")
        .overflow_x_scroll()
        .items_end()
        .border_b(1)
        .border_color(t.border)
        .children(
          TABS.map(({ id, label, ...x }) =>
            h_flex()
              .id(`tab-${id}`)
              .h(34)
              .gap(5)
              .items_center()
              .border_b(2)
              .border_color(tab === id ? t.accent : alpha(t.accent, 0))
              .text_size(12)
              .cursor_pointer()
              .text_color(tab === id ? t.foreground : t.muted)
              .when(tab === id, (el) => el.font_semibold())
              .on_click((_e, cx) => app.setTab(id, cx))
              .child(label)
              .when(Boolean(countOf({ id, label, ...x })), (el) => el.child(div().px(5).rounded(8).bg(t.hover).text_size(10.5).text_color(t.muted).child(String(countOf({ id, label, ...x }))))),
          ),
        ),
    )
    .child(
      v_flex()
        .id(`inspector-body-${tab}`)
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .px(10)
        .py(10)
        .when(Boolean(current), (el) => el.child(current.render(app, t, task, detail))),
    );
}

// The inspector's own tabs; feature files add more (registry.js).
addTab({ id: "details", label: "Details", order: 10, render: (app, t, task, detail) => details(app, t, task, detail) });
addTab({ id: "activity", label: "Activity", order: 60, count: (app, task, detail) => detail?.events?.length, render: (app, t, task, detail) => activity(t, detail) });
addTab({ id: "runs", label: "Runs", order: 40, count: (app, task, detail) => detail?.stageRuns?.length, render: (app, t, task, detail) => runs(t, detail) });
addTab({ id: "changes", label: "Changes", order: 50, count: (app, task) => app.diffs[task.id]?.files?.length, enter: (app, task, cx) => app.loadDiff(task.id, cx), render: (app, t, task) => changes(app, t, task) });
