// The PR page: the inbox (yours and those asking your review) and every open PR in your repos,
// split as the machine splits them, with the actions the machine takes (review, fix CI, address,
// merge, clone, close). A row opens to show every check by name. The machine polls GitHub; this
// reads its snapshot and the stream's updates.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { notify, pickFolder } from "herdr";

import { ago, prActions, prStatus } from "./model.js";
import { PR_SPLIT_ORDER, checkRows, checkTone, keyName, orderPrs, prCloseRefusal, prKeyRefusal, prNeedsCount, prNotices, stepSplit } from "./controls.js";
import { alpha, button, chip, dot, icon, mono, projectColor, spinner, toneColor } from "./ui.js";

const prKey = (pr) => `${pr.repo}#${pr.number}`;

function tabs(app, t) {
  const tab = (id, label) =>
    h_flex()
      .id(`prlist-${id}`)
      .h(34)
      .items_center()
      .border_b(2)
      .border_color(app.prList === id ? t.accent : t.canvas)
      .text_size(12.5)
      .cursor_pointer()
      .text_color(app.prList === id ? t.foreground : t.muted)
      .when(app.prList === id, (el) => el.font_semibold())
      .on_click((_e, cx) => app.showPrList(id, cx))
      .child(label);
  return h_flex().gap(18).px(16).items_end().border_b(1).border_color(t.border).child(tab("inbox", "Involving you")).child(tab("all", "All repos"));
}

function splitBar(app, t, prs) {
  const pill = (id, label, n) =>
    h_flex()
      .id(`split-${id ?? "all"}`)
      .h(24)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(12)
      .text_size(11.5)
      .cursor_pointer()
      .when(app.prSplit === id, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
      .when(app.prSplit !== id, (el) => el.bg(t.hover).text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => {
        app.prSplit = id;
        cx.notify();
      })
      .child(label)
      .child(div().text_size(10.5).child(String(n)));
  const repos = [...new Set(prs.map((p) => p.repo))].sort();
  return h_flex()
    .px(16)
    .py(10)
    .gap(6)
    .flex_wrap()
    .items_center()
    .child(pill(null, "All", prs.length))
    .children(PR_SPLIT_ORDER.map(([id, label]) => [id, label, prs.filter((p) => p.split === id).length]).filter(([, , n]) => n > 0).map(([id, label, n]) => pill(id, label, n)))
    .child(div().flex_1())
    .when(repos.length > 1, (el) =>
      el.child(
        button(t, "repo-filter", app.prRepo ?? `All ${repos.length} repos`, "plain", (_e, cx) => app.pickRepo(repos, cx), { iconName: "filter", small: true }),
      ),
    )
    .when(Boolean(app.prRepo), (el) => el.child(button(t, "repo-clear", "", "quiet", (_e, cx) => { app.prRepo = null; cx.notify(); }, { iconName: "close", small: true })));
}

/** Every check by name with its state and link, and the threads still open. */
function checksPanel(app, t, pr) {
  const rows = checkRows(pr);
  return v_flex()
    .px(14)
    .pb(10)
    .gap(2)
    .child(
      h_flex()
        .gap(10)
        .pb(4)
        .text_size(11)
        .text_color(t.dim)
        .child(div().font_family(mono()).text_size(10.5).child(`${pr.headRef ?? "?"} → ${pr.baseRef ?? "?"}`))
        .child(div().child(`${pr.unresolvedThreads ?? 0} unresolved thread${pr.unresolvedThreads === 1 ? "" : "s"}`))
        .when(Boolean(pr.reviewDecision), (el) => el.child(div().child(String(pr.reviewDecision).toLowerCase().replaceAll("_", " ")))),
    )
    .when(rows.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No checks reported.")))
    .children(
      rows.map((c, i) => {
        const tone = checkTone(c.state);
        const color = tone ? toneColor(t, tone) : t.dim;
        return h_flex()
          .id(`chk-${pr.repo}-${pr.number}-${i}`)
          .h(24)
          .px(6)
          .gap(8)
          .items_center()
          .rounded(6)
          .when(Boolean(c.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
            cx.stop_propagation();
            app.openUrl(c.url);
          }))
          .child(dot(color, 7))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.name))
          .child(div().flex_none().text_size(10.5).text_color(color).child(String(c.state ?? "").toLowerCase().replaceAll("_", " ")))
          .when(Boolean(c.url), (el) => el.child(icon("external", 11, t.dim)));
      }),
    );
}

function row(app, t, pr, cloning) {
  const status = prStatus(pr);
  const actions = prActions(pr);
  const key = prKey(pr);
  const open = Boolean(app.prOpen?.has(key));
  const selected = app.prSel === key;
  const busy = app.busy.has(key) || Boolean(cloning);
  const name = pr.repo.split("/")[1] ?? pr.repo;
  const toggle = (_e, cx) => {
    app.prOpen ??= new Set();
    app.prOpen.has(key) ? app.prOpen.delete(key) : app.prOpen.add(key);
    cx.notify();
  };
  return v_flex()
    .id(`pr-${pr.repo}-${pr.number}`)
    .rounded(9)
    .bg(selected ? alpha(t.accent, 0.08) : t.background)
    .border_1()
    .border_color(selected ? t.accent : t.border)
    .hover((s) => s.border_color(selected ? t.accent : t.input))
    .child(
      h_flex()
        .id(`prrow-${pr.repo}-${pr.number}`)
        .px(14)
        .py(10)
        .gap(12)
        .items_center()
        .cursor_pointer()
        .on_click((e, cx) => {
          app.prSel = key;
          if (pr.task) return app.prAct(pr, "open_task", cx);
          return toggle(e, cx);
        })
        .child(button(t, `pr-exp-${pr.repo}-${pr.number}`, "", "quiet", (e, cx) => {
          app.prSel = key;
          toggle(e, cx);
        }, { small: true, iconName: open ? "chevron-down" : "chevron-right" }))
        .child(icon("pr", 15, pr.isDraft ? t.dim : pr.mine ? t.accent : t.done))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(3)
            .child(div().truncate().text_size(12.8).font_medium().text_color(t.foreground).child(pr.title))
            .child(
              h_flex()
                .gap(7)
                .items_center()
                .text_size(11)
                .text_color(t.dim)
                .child(dot(projectColor(t, name), 6))
                .child(div().font_family(mono()).text_size(10.5).child(key))
                .child(div().child(`· ${pr.mine ? "you" : pr.author}`))
                .child(div().child(`· ${ago(pr.updatedAt) ?? ""}`))
                .when(pr.unresolvedThreads > 0, (el) => el.child(div().child(`· ${pr.unresolvedThreads} unresolved`)))
                .when(Boolean(pr.task), (el) => el.child(chip(t, "task running", "working")))
                .when(!pr.localPath, (el) => el.child(chip(t, cloning ? "cloning…" : "not cloned"))),
            ),
        )
        .child(chip(t, status.text, status.tone, 11))
        .child(
          h_flex()
            .gap(6)
            .flex_none()
            .when(Boolean(cloning), (el) => el.child(spinner(t, 12)))
            .children(actions.map((a) => button(t, `pra-${pr.repo}-${pr.number}-${a.id}`, a.label, a.kind, (_e, cx) => dispatchPr(app, pr, a.id, cx), { small: true, busy, iconName: a.id === "browser" ? "external" : null })))
            .child(closeButton(app, t, pr, busy)),
        ),
    )
    .when(open, (el) => el.child(checksPanel(app, t, pr)));
}

/** Close…: only on your own PRs with no task running (the TUI's rule); otherwise it is off and says why. */
function closeButton(app, t, pr, busy) {
  const why = prCloseRefusal(pr);
  const b = button(t, `pra-${pr.repo}-${pr.number}-close`, "Close…", "danger", (_e, cx) => closePr(app, pr, cx), { small: true, busy: busy || Boolean(why) });
  return why ? b.tooltip(why) : b;
}

/** Asks before closing a PR without merging it; a PR that is not yours, or has a task running, says why instead. */
export function closePr(app, pr, cx) {
  const why = prCloseRefusal(pr);
  if (why) {
    app.say(`close: ${why}`);
    return cx?.notify?.();
  }
  app.dialog({ kind: "close_pr", repo: pr.repo, number: pr.number, subtitle: pr.title }, 240);
}

// ---- a dispatch on an uncloned PR: ask for the folder, clone, wait for it, then run ----

const later = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const NEEDS_CLONE = ["review", "ci_fix", "address"];
const CLONE_WAIT_MS = 5 * 60 * 1000;

const snapshotsOf = (app) => [app.prs?.inbox, app.prs?.all].filter(Boolean);
const cloneOf = (app, repo) => snapshotsOf(app).flatMap((s) => s.clones ?? []).find((c) => c.repo === repo && c.state === "cloning") ?? null;
const findPr = (snaps, pr) => snaps.flatMap((s) => s.prs ?? []).find((p) => p.repo === pr.repo && p.number === pr.number);

/**
 * `review`, `ci_fix` and `address` need a checkout. With none, this asks for the folder, clones into
 * it, waits until the snapshot shows the clone, then runs the action (the TUI's `open_clone_prompt`
 * and `run_pending_dispatch`). Everything else, and a PR already cloned, goes straight to `app.prAct`.
 */
export function dispatchPr(app, pr, id, cx) {
  if (!NEEDS_CLONE.includes(id) || pr.localPath || pr.task) return app.prAct(pr, id, cx);
  const key = prKey(pr);
  const name = pr.repo.split("/")[1] ?? pr.repo;
  app.prPending ??= new Set();
  if (app.prPending.has(key)) return app.say(`${id} on ${key} is waiting for the clone`);
  const wait = async (cx2, cloned) => {
    const until = Date.now() + CLONE_WAIT_MS;
    while (Date.now() < until) {
      const now = findPr(snapshotsOf(app), pr);
      if (now?.localPath) return now;
      const failed = snapshotsOf(app).flatMap((s) => s.clones ?? []).find((c) => c.repo === pr.repo && c.state === "failed" && (!cloned || c.dest === cloned));
      if (failed) throw new Error(`the clone failed: ${failed.error ?? "no reason given"}`);
      try {
        const fresh = await app.machine.prs(app.prList === "all");
        const hit = findPr([fresh], pr);
        if (hit?.localPath) return hit;
      } catch {
        // the stream may still deliver it
      }
      await later(cx2, 1500);
    }
    throw new Error(`the clone of ${pr.repo} did not land in time`);
  };
  cx.spawn(async (cx2) => {
    app.prPending.add(key);
    cx2.notify();
    try {
      let dest = cloneOf(app, pr.repo)?.dest ?? null;
      if (dest) app.say(`already cloning into ${dest}; ${id} runs when it lands`);
      else {
        const folder = await pickFolder({ prompt: `Clone ${pr.repo} here, then ${id.replace("_", " ")}` });
        if (!folder) return;
        dest = `${folder.replace(/\/+$/, "")}/${name}`;
        await app.machine.clone(pr.repo, dest);
        app.say(`Cloning ${pr.repo} into ${dest}; ${id} runs when it lands`);
      }
      const landed = await wait(cx2, dest);
      app.prAct({ ...pr, localPath: landed.localPath }, id, cx2);
    } catch (e) {
      app.say(e?.message ?? String(e), "error");
    } finally {
      app.prPending.delete(key);
      cx2.notify();
    }
  });
}

// ---- the badge and the notices ----

/**
 * Remembers each PR's split across polls and raises a Herdr notice for every PR that gains a split
 * needing you (review requested, ready to merge, CI failed, changes requested), once. The first
 * snapshot only sets the baseline: starting a pane does not announce what was already waiting.
 */
export function notePrs(app, snapshot) {
  const prs = snapshot?.prs;
  if (!Array.isArray(prs)) return [];
  const st = app.state ? app.state("pr-notices") : (app.prNoticeState ??= {});
  st.seen ??= new Map();
  const first = !st.ready;
  st.ready = true;
  const found = prNotices(prs, st.seen);
  if (first) return [];
  for (const n of found) {
    try {
      notify({ title: n.title, body: n.body, level: "info" });
    } catch {
      // no notice surface: the badge still counts
    }
  }
  return found;
}

/** The PR page's `onMessage`: every `github.prs` snapshot is looked at for the notices. */
export function prsMessage(app, { event, data }) {
  if (event === "github.prs") notePrs(app, data);
  return false;
}

/** The PR page's badge: PRs in a split that needs you, not only review requested. (core.js should use this.) */
export function prBadge(app) {
  const snap = app.prs?.inbox;
  notePrs(app, snap);
  const n = prNeedsCount(snap?.prs ?? []);
  return n ? { n, tone: null } : null;
}

/** The PR page's keys, as the TUI's Pulls view: rows, splits, the per-PR actions. */
export function prsKey(app, e, cx) {
  const name = keyName(e);
  const rows = app.prRows ?? [];
  const at = rows.findIndex((p) => prKey(p) === app.prSel);
  const pr = rows[at] ?? null;
  const go = (i) => {
    if (rows.length) app.prSel = prKey(rows[Math.max(0, Math.min(rows.length - 1, i))]);
    cx.notify();
    return true;
  };
  const splits = app.prSplitIds ?? [null];
  const needsRow = (fn) => {
    if (!pr) {
      app.say("no pull request selected");
      cx.notify();
      return true;
    }
    return fn(pr);
  };
  const dispatch = (id, label) =>
    needsRow((p) => {
      // A dispatch on an uncloned PR clones first, so judge it as if cloned.
      const as = { ...p, localPath: p.localPath ?? "(to clone)" };
      const why = prKeyRefusal(as, id, prActions(as).map((a) => a.id));
      if (why) app.say(`${label}: ${why}`, "error");
      else dispatchPr(app, p, id, cx);
      cx.notify();
      return true;
    });
  switch (name) {
    case "j":
    case "down": return go(at < 0 ? 0 : at + 1);
    case "k":
    case "up": return go(at < 0 ? 0 : at - 1);
    case "h":
    case "left":
      app.prSplit = stepSplit(splits, app.prSplit, -1);
      cx.notify();
      return true;
    case "l":
    case "right":
      app.prSplit = stepSplit(splits, app.prSplit, 1);
      cx.notify();
      return true;
    case "m": return dispatch("merge", "merge");
    case "c": return dispatch("ci_fix", "CI fix");
    case "v": return dispatch("review", "review");
    case "t": return dispatch("address", "threads");
    case "C": return needsRow((p) => {
      if (p.localPath) app.say("already cloned", "error");
      else app.prAct(p, "clone", cx);
      cx.notify();
      return true;
    });
    case "X": return needsRow((p) => {
      closePr(app, p, cx);
      return true;
    });
    case "o": return needsRow((p) => {
      app.openUrl(p.url);
      return true;
    });
    case "enter": return needsRow((p) => {
      if (p.task) app.prAct(p, "open_task", cx);
      else app.openUrl(p.url);
      return true;
    });
    case "space":
    case " ":
    case "x": return needsRow((p) => {
      app.prOpen ??= new Set();
      const k = prKey(p);
      app.prOpen.has(k) ? app.prOpen.delete(k) : app.prOpen.add(k);
      cx.notify();
      return true;
    });
    case "f":
      app.pickRepo([...new Set((app.prAllRepos ?? []))].sort(), cx);
      return true;
    case "F":
      app.prRepo = null;
      cx.notify();
      return true;
    case "R":
      app.refreshPrs(cx);
      return true;
    case "escape":
    case "P":
    case "q":
      app.go("board", cx);
      return true;
    default:
      break;
  }
  if (/^[1-7]$/.test(name)) {
    const d = Number(name);
    if (d === 7) app.showPrList("all", cx);
    else {
      app.showPrList("inbox", cx);
      app.prSplit = PR_SPLIT_ORDER[d - 1][0];
    }
    cx.notify();
    return true;
  }
  return false;
}

/** The PR page. */
export function prsPage(app, t) {
  const snap = app.prList === "all" ? app.prs.all : app.prs.inbox;
  const all = snap?.prs ?? [];
  const shown = orderPrs(all, { split: app.prList === "all" ? null : app.prSplit, repo: app.prRepo, query: app.query });
  const clones = new Map((snap?.clones ?? []).filter((c) => c.state === "cloning").map((c) => [c.repo, c]));
  // What the keys use: the rows as drawn, the splits that hold PRs and the repos to filter by.
  const rows = shown.slice(0, 200);
  app.prRows = rows;
  app.prSplitIds = [null, ...PR_SPLIT_ORDER.map(([id]) => id).filter((id) => all.some((p) => p.split === id))];
  app.prAllRepos = [...new Set(all.map((p) => p.repo))];
  if (rows.length && !rows.some((p) => prKey(p) === app.prSel)) app.prSel = prKey(rows[0]);
  return v_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .bg(t.canvas)
    .child(
      h_flex()
        .h(56)
        .flex_none()
        .px(16)
        .gap(10)
        .items_center()
        .child(
          v_flex()
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Pull requests"))
            .child(div().text_size(11).text_color(snap?.error ? toneColor(t, "error") : t.dim).truncate().child(snap?.error ?? (snap?.polledAt ? `${all.length} open · read from GitHub ${ago(snap.polledAt)}` : "Not read yet"))),
        )
        .child(div().flex_1())
        .when(Boolean(app.flash), (el) => el.child(div().max_w(420).truncate().text_size(11.5).text_color(app.flash.tone ? toneColor(t, app.flash.tone) : t.muted).child(app.flash.text)))
        .when(app.prRefreshing, (el) => el.child(spinner(t, 13)))
        .child(button(t, "pr-refresh", "Refresh", "plain", (_e, cx) => app.refreshPrs(cx), { iconName: "refresh", small: true, busy: app.prRefreshing })),
    )
    .child(tabs(app, t))
    .child(splitBar(app, t, all))
    .child(
      v_flex()
        .id(`pr-list-${app.prList}`)
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .px(16)
        .pb(12)
        .gap(6)
        .when(!snap, (el) => el.child(h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the PRs…")))
        .when(Boolean(snap) && shown.length === 0, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child(all.length ? "No PR in this split." : app.prList === "all" ? "The machine has not read your repos yet: it polls them every 15 minutes, Refresh starts it now." : "No open PR involves you.")))
        .children(rows.map((pr) => row(app, t, pr, clones.get(pr.repo)))),
    );
}
