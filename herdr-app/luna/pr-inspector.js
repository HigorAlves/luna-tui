// The PR page's detail panel, beside the list as the ticket inspector sits beside the board: what the
// PR is (status, branches, reviews, threads, every check, its card, its description) and what you
// can do to it, each action with the TUI's key. An action that cannot run now stays listed, dimmed,
// with the reason, as the TUI's Pulls view says it.
import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";

import { ago, prActions, prStatus, stageWords } from "./model.js";
import { checkRows, checkTone, prCloseRefusal, prKeyRefusal } from "./controls.js";
import { closePr, dispatchPr } from "./prs.js";
import { button, chip, dot, fact, icon, mono, projectColor, spinner, toneColor } from "./ui.js";

const prKey = (pr) => `${pr.repo}#${pr.number}`;

/** The PR the panel shows: the selected one, when the panel is open and the PR is still listed. */
export function panelPr(app) {
  if (!app.prPanel || !app.prSel) return null;
  return (app.prRows ?? []).find((p) => prKey(p) === app.prSel) ?? null;
}

/**
 * Every PR action in the TUI's order, each with its key, whether it can run now and why not.
 * A review, CI fix or address on an uncloned PR clones first (the TUI's dispatch), so it is judged as if cloned.
 */
export function panelActions(pr) {
  const asCloned = { ...pr, localPath: pr.localPath ?? "(to clone)" };
  const can = prActions(asCloned).map((a) => a.id);
  const dispatch = (id, label, key, what) => ({ id, label, key, what, why: prKeyRefusal(asCloned, id, can) });
  const out = [];
  if (pr.task) out.push({ id: "open_task", label: "Open its card", key: "enter", what: `${stageWords(pr.task.state)} now`, why: null, primary: true });
  out.push(
    dispatch("review", "Review", "v", "an agent reads the diff and drafts line comments; nothing posts until you approve it"),
    dispatch("ci_fix", "Fix CI", "c", "an agent repairs the red run on the PR's branch"),
    dispatch("address", "Answer the threads", "t", "an agent answers every open review thread"),
    { id: "merge", label: "Merge", key: "m", what: "merges the way the repository allows and deletes the branch (asks first)", why: prKeyRefusal(pr, "merge", prActions(pr).map((a) => a.id)) },
    { id: "clone", label: "Clone…", key: "C", what: "clones the repository into a folder you pick", why: pr.localPath ? `already cloned at ${pr.localPath}` : null },
    { id: "close", label: "Close…", key: "X", what: "closes it without merging; the branch stays (asks first)", why: prCloseRefusal(pr), danger: true },
    { id: "browser", label: "Open on GitHub", key: "o", what: pr.url ?? "", why: null },
  );
  const first = out.find((a) => !a.why && a.id !== "browser");
  if (first && !out.some((a) => a.primary)) first.primary = true;
  return out;
}

function runAction(app, pr, a, cx) {
  if (a.why) {
    app.say(`${a.label}: ${a.why}`, "error");
    return cx.notify();
  }
  if (a.id === "close") return closePr(app, pr, cx);
  if (a.id === "browser") return app.openUrl(pr.url);
  return dispatchPr(app, pr, a.id, cx);
}

/** One action as a row: its key, its label, and what it does — or, dimmed, why it can't run now. */
function actionRow(app, t, pr, a, busy) {
  const off = Boolean(a.why) || busy;
  const fg = a.danger ? toneColor(t, "error") : a.primary && !off ? t.accent : t.foreground;
  return h_flex()
    .id(`pra-${pr.repo}-${pr.number}-${a.id}`)
    .px(8)
    .py(6)
    .gap(10)
    .items_start()
    .rounded(7)
    .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => runAction(app, pr, a, cx)))
    .when(off, (el) => el.opacity(0.55))
    .child(
      div()
        .flex_none()
        .min_w(26)
        .h(18)
        .px(5)
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .font_family(mono())
        .text_size(10.5)
        .text_color(t.muted)
        .child(a.key),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(1)
        .child(div().text_size(12.5).font_medium().text_color(fg).child(a.label))
        .child(div().text_size(11).text_color(a.why ? t.dim : t.muted).child(a.why ? `off: ${a.why}` : a.what)),
    );
}

function section(t, label, extra = null) {
  return h_flex()
    .pt(12)
    .pb(4)
    .px(2)
    .gap(8)
    .items_center()
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(label))
    .when(extra != null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(extra)));
}

function checks(app, t, pr) {
  const rows = checkRows(pr);
  if (!rows.length) return [div().px(2).text_size(12).text_color(t.dim).child("No checks reported.")];
  return rows.map((c, i) => {
    const tone = checkTone(c.state);
    const color = tone ? toneColor(t, tone) : t.dim;
    return h_flex()
      .id(`pchk-${pr.repo}-${pr.number}-${i}`)
      .h(24)
      .px(6)
      .gap(8)
      .items_center()
      .rounded(6)
      .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => app.openUrl(c.url)))
      .child(dot(color, 7))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(String(c.name ?? "")))
      .child(div().flex_none().text_size(10.5).text_color(color).child(String(c.state ?? "").toLowerCase().replaceAll("_", " ")))
      .when(Boolean(c.url), (el) => el.child(icon("external", 11, t.dim)));
  });
}

const REVIEW_WORDS = { APPROVED: ["approved", "done"], CHANGES_REQUESTED: ["changes requested", "blocked"], REVIEW_REQUIRED: ["review required", null] };
const MERGE_WORDS = {
  CLEAN: "can merge", HAS_HOOKS: "can merge (hooks run)", UNSTABLE: "can merge (a check is not green)", BLOCKED: "blocked: a rule still waits",
  BEHIND: "behind its base", DIRTY: "has conflicts", DRAFT: "a draft", UNKNOWN: "GitHub is still working it out",
};

/** The panel, or null when no PR is open in it. */
export function prInspector(app, t, width) {
  const pr = panelPr(app);
  if (!pr) return null;
  const key = prKey(pr);
  const status = prStatus(pr);
  const name = pr.repo.split("/")[1] ?? pr.repo;
  const busy = app.busy.has(key) || Boolean(app.prPending?.has(key));
  const cloning = [app.prs?.inbox, app.prs?.all].filter(Boolean).flatMap((s) => s.clones ?? []).find((c) => c.repo === pr.repo && c.state === "cloning");
  const review = REVIEW_WORDS[pr.reviewDecision];
  const actions = panelActions(pr);
  const facts = [
    ["Author", pr.mine ? `${pr.author} (you)` : pr.author],
    ["Updated", ago(pr.updatedAt)],
    ["Checks", pr.checks?.total ? `${pr.checks.passed} of ${pr.checks.total} passed` : "none"],
    ["Threads", `${pr.unresolvedThreads ?? 0} open`],
    ["Merge", MERGE_WORDS[pr.mergeState] ?? pr.mergeState],
    ["Checkout", cloning ? `cloning into ${cloning.dest}` : pr.localPath ?? "not cloned"],
  ];
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
            .child(dot(projectColor(t, name), 6))
            .child(div().font_family(mono()).font_semibold().text_color(t.foreground).child(key))
            .child(div().flex_1())
            .when(busy, (el) => el.child(spinner(t, 12)))
            .child(button(t, "close-pr-panel", "", "quiet", (_e, cx) => {
              app.prPanel = false;
              cx.notify();
            }, { iconName: "close", small: true })),
        )
        .child(div().text_size(16).font_bold().text_color(t.foreground).child(pr.title ?? ""))
        .child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(chip(t, status.text, status.tone, 11))
            .when(Boolean(review) && review[0] !== status.text.toLowerCase(), (el) => el.child(chip(t, review[0], review[1], 11)))
            .when(pr.isDraft, (el) => el.child(chip(t, "draft", null, 11)))
            .when(pr.fromFork, (el) => el.child(chip(t, "from a fork", null, 11)))
            .when(Boolean(pr.task), (el) => el.child(chip(t, `card: ${stageWords(pr.task.state)}`, "working", 11))),
        )
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim).child(icon("branch", 12, t.dim)).child(div().font_family(mono()).text_size(10.5).truncate().child(`${pr.headRef ?? "?"} → ${pr.baseRef ?? "?"}`))),
    )
    .child(
      v_flex()
        .id(`pr-panel-${key}`)
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .px(10)
        .py(8)
        .child(section(t, "Actions"))
        .children(actions.map((a) => actionRow(app, t, pr, a, busy)))
        .child(section(t, "Facts"))
        .child(h_flex().flex_wrap().children(facts.map(([k, v]) => div().w_1_2().child(fact(t, k, v, { monoValue: k === "Checkout" })))))
        .child(section(t, "Checks", pr.checks?.total ? `${pr.checks.passed}/${pr.checks.total}` : null))
        .children(checks(app, t, pr))
        .when(Boolean(pr.body?.trim()), (el) => el.child(section(t, "Description")).child(div().px(2).child(TextView.markdown(`prbody-${key}`, String(pr.body)).selectable(true))))
        .child(div().h(8)),
    )
    .child(
      h_flex()
        .px(16)
        .py(8)
        .gap(10)
        .flex_wrap()
        .border_t(1)
        .border_color(t.border)
        .text_size(10.5)
        .text_color(t.dim)
        .children(["j/k move", "h/l split", "enter card or PR", "esc close", "f repo", "R refresh"].map((s) => div().child(s))),
    );
}

