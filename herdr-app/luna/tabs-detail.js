// The inspector's ticket tabs, after the TUI's sections: Overview, Plan, Tests, Runs and PR.
// Each replaces or adds a tab by id (registry.js) and says a plain sentence when it has nothing to show.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { ago, money, plainTitle, projectOf, stageWords } from "./model.js";
import { bullet, codeBlock, markdown, sub } from "./inspector.js";
import { alpha, button, chip, mono, toneColor } from "./ui.js";
import { tab } from "./registry.js";
import { approver, criteriaRows, jiraSummary, latestApproval, planCriteria, planHistory, pickedRun, prFor, prUrlOf, runError, runTook, slaParts, testCases, testGroups } from "./detail-model.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const s = (v) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? v.text ?? v.title ?? v.description ?? v.question ?? JSON.stringify(v) : String(v));

const fallback = {};
/** A feature's state on the app (`app.state(id)`), or a module copy when the app has none (a bare stand-in). */
export const ownState = (app, id) => (typeof app.state === "function" ? app.state(id) : (fallback[id] ??= {}));

/** A short plain sentence for a tab with nothing to show. */
export const note = (t, text) => div().p(6).text_size(12).text_color(t.dim).child(text);

const reading = (t, detail, empty) => note(t, detail ? empty : "Reading…");

const row = (t, label, value, tone = null) =>
  h_flex()
    .gap(10)
    .items_start()
    .py(2)
    .child(div().w(70).flex_none().text_size(11).text_color(t.dim).child(label))
    .child(div().flex_1().min_w(0).text_size(12).text_color(tone ? toneColor(t, tone) : t.foreground).child(value));

const mark = (t, ok) => (ok == null ? div().w(12).flex_none().text_color(t.dim).child("–") : div().w(12).flex_none().text_color(toneColor(t, ok ? "done" : "error")).child(ok ? "✓" : "✗"));

// ---- Overview ----

function overview(app, t, task, detail) {
  const now = Date.now();
  const rows = criteriaRows(task, detail);
  const sla = slaParts(task.sla, now);
  const jira = jiraSummary(task.jira, now);
  const setup = arr(detail?.approvals).length ? latestApproval(detail, "awaiting_setup") : null;
  const memory = latestApproval(detail, "reviewing_memory");
  const rules = memory?.requested?.rules;
  const setupYaml = task.gate?.requested?.yaml ?? setup?.requested?.yaml ?? null;
  const proof = task.gate?.requested?.proof ?? setup?.requested?.proof ?? null;
  const el = v_flex().gap(3);
  if (task.reason) el.child(div().pb(4).text_size(12.5).text_color(toneColor(t, task.archiveReason ? null : "blocked")).child(`Why: ${task.reason}`));
  if (rows.length) {
    el.child(sub(t, "Acceptance criteria", String(rows.length)));
    rows.forEach((r, i) =>
      el.child(
        h_flex()
          .id(`crit-${i}`)
          .gap(8)
          .items_start()
          .py(3)
          .child(mark(t, r.planned))
          .child(div().w(26).flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(r.id || `${i + 1}`))
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(r.text))
          .child(div().flex_none().text_size(10.5).text_color(r.cases ? t.muted : toneColor(t, "blocked")).child(r.cases ? `${r.cases} case${r.cases === 1 ? "" : "s"}` : "no case"))
          .when(Boolean(r.verify), (x) => x.child(div().flex_none().text_size(10.5).text_color(toneColor(t, r.verify.ok === r.verify.total ? "done" : "error")).child(`${r.verify.ok}/${r.verify.total} pass`))),
      ),
    );
  }
  el.child(sub(t, "Where"));
  el.child(row(t, "Project", projectOf(task)));
  el.child(row(t, "Repo", task.repoPath ?? "none: set one to start it"));
  if (task.branch) el.child(row(t, "Branch", task.branch));
  const issue = task.source?.issue ?? task.source?.number ?? null;
  if (task.source?.kind || issue) el.child(row(t, "Issue", [task.source.kind, issue ? `#${issue}` : null, task.source.url ?? task.source.ref].filter(Boolean).join(" · ")));
  el.child(row(t, "Jira", jira ?? "not linked"));
  if (task.jira?.url) el.child(h_flex().pl(80).child(button(t, "open-jira", "Open in Jira", "quiet", () => app.openUrl(task.jira.url), { iconName: "external", small: true })));
  if (task.jira?.blocked) el.child(row(t, "Blocked", s(task.jira.blocked.why ?? task.jira.blocked), "error"));
  if (sla.length) {
    el.child(
      h_flex()
        .gap(10)
        .items_start()
        .py(2)
        .child(div().w(70).flex_none().text_size(11).text_color(t.dim).child("SLA"))
        .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().children(sla.map((p) => chip(t, p.text, p.tone, 11)))),
    );
  }
  if (task.archiveReason) el.child(row(t, "Archived", task.archiveReason === "split" ? "split into smaller changes" : task.archiveReason));
  if (task.retries?.total > 0) el.child(row(t, "Failures", `verify ${task.retries.verify ?? 0} · e2e ${task.retries.e2e ?? 0} · ci ${task.retries.ci ?? 0}`));
  el.child(row(t, "Spent", `${money(task.spentUsd) ?? "–"}${task.updatedAt ? ` · updated ${ago(task.updatedAt) ?? ""}` : ""}`));
  const last = task.lastRun;
  if (last?.summary) el.child(sub(t, "Last run", `${stageWords(last.stage)} · ${last.outcome ?? ""}`)).child(div().text_size(12.5).text_color(t.foreground).child(String(last.summary).slice(0, 600)));
  el.child(sub(t, "Description"));
  el.child(task.description ? markdown(`desc-${task.id}`, String(task.description)) : div().text_size(12).text_color(t.dim).child("No description yet."));
  if (setupYaml) el.child(sub(t, "luna.yaml")).child(codeBlock(t, String(setupYaml).slice(0, 3000)));
  if (proof) el.child(sub(t, "Proof")).child(typeof proof === "string" ? codeBlock(t, proof.slice(0, 1500)) : codeBlock(t, JSON.stringify(proof, null, 1).slice(0, 1500)));
  if (rules) {
    el.child(sub(t, "Memory review: the rules"));
    el.child(typeof rules === "string" ? markdown(`rules-${task.id}`, rules) : rules.markdown ? markdown(`rules-${task.id}`, String(rules.markdown)) : codeBlock(t, JSON.stringify(rules, null, 1).slice(0, 2000)));
    if (memory?.requested?.error) el.child(div().text_size(12).text_color(toneColor(t, "error")).child(String(memory.requested.error)));
  }
  return el;
}

// ---- Plan ----

function plan(app, t, task, detail) {
  const a = latestApproval(detail, "awaiting_approval");
  if (!a) return reading(t, detail, "No plan yet: triage has not made one.");
  const r = a.requested ?? {};
  const p = r.plan ?? {};
  const el = v_flex().gap(3);
  const state = a.decision ? (a.decision === "approved" ? ["Approved", "done"] : [a.decision.replaceAll("_", " "), a.decision === "rejected" ? "error" : "blocked"]) : ["Waiting on you", "blocked"];
  el.child(h_flex().gap(6).items_center().child(chip(t, state[0], state[1], 11)).when(Boolean(r.risk?.level), (x) => x.child(chip(t, `${r.risk.level} risk`, r.risk.level === "high" ? "error" : r.risk.level === "medium" ? "blocked" : null, 11))).when(Boolean(r.size?.estLoc), (x) => x.child(chip(t, `~${r.size.estLoc} lines`, null, 11))));
  if (r.risk?.reason) el.child(div().text_size(11.5).text_color(t.dim).child(String(r.risk.reason)));
  if (r.brief) el.child(sub(t, "Brief")).child(markdown(`plan-brief-${task.id}`, String(r.brief)));
  else if (p.goal) el.child(sub(t, "Goal")).child(markdown(`plan-goal-${task.id}`, String(p.goal)));
  const crit = planCriteria(a, task);
  if (crit.length) {
    el.child(sub(t, "Criteria", String(crit.length)));
    crit.forEach((c) => el.child(bullet(t, c.text, { mark: c.id || "•" })));
  }
  const assumptions = arr(r.assumptions).length ? arr(r.assumptions) : arr(p.assumptions);
  if (assumptions.length) {
    el.child(sub(t, "Assumptions", String(assumptions.length)));
    assumptions.forEach((x) => el.child(bullet(t, s(x))));
  }
  const steps = arr(p.steps).length ? arr(p.steps) : arr(r.steps).length ? arr(r.steps) : arr(r.slices);
  if (steps.length) {
    el.child(sub(t, "Steps", String(steps.length)));
    steps.forEach((st, i) => {
      const files = [...arr(st.files), ...arr(st.new_files)].filter((f) => typeof f === "string");
      el.child(
        v_flex()
          .id(`step-${i}`)
          .gap(2)
          .py(3)
          .child(bullet(t, `${s(st.title ?? st.description ?? st)}${st.est_loc ? `  ·  ~${st.est_loc} lines` : ""}`, { mark: st.id ?? `${i + 1}` }))
          .when(files.length > 0, (x) => x.child(div().pl(20).font_family(mono()).text_size(10.5).text_color(t.dim).child(files.join("  "))))
          .when(Boolean(st.done_when), (x) => x.children(arr(st.done_when).slice(0, 4).map((d) => div().pl(20).text_size(11).text_color(t.muted).child(`done when: ${s(d)}`)))),
      );
    });
  }
  const rollback = p.rollback ?? r.rollback;
  if (rollback) el.child(sub(t, "Rollback")).child(div().text_size(12).text_color(t.foreground).child(s(rollback)));
  if (p.migration) el.child(sub(t, "Migration")).child(div().text_size(12).text_color(t.foreground).child(s(p.migration)));
  if (arr(p.out_of_scope).length) {
    el.child(sub(t, "Out of scope"));
    p.out_of_scope.forEach((x) => el.child(bullet(t, s(x))));
  }
  const gaps = arr(r.coverageReport?.gaps);
  if (gaps.length) el.child(div().pt(6).text_size(11.5).text_color(t.blocked).child(`${gaps.length} criteria no test covers: ${gaps.map((g) => s(g.id ?? g)).join(", ")}`));
  const map = r.map ?? null;
  if (map) {
    el.child(sub(t, "Code map", map.confidence != null ? `${Math.round(map.confidence * 100)}% sure${map.stale ? " · stale" : ""}` : map.stale ? "stale" : null));
    if (map.note) el.child(div().text_size(11.5).text_color(t.dim).child(String(map.note)));
    arr(map.components).forEach((c) => el.child(bullet(t, s(c))));
    arr(map.files).slice(0, 25).forEach((f) => el.child(h_flex().gap(8).child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(10.5).text_color(t.foreground).child(s(f.path ?? f))).when(Boolean(f.role), (x) => x.child(div().text_size(10.5).text_color(t.dim).child(String(f.role))))));
  }
  const history = planHistory(detail);
  el.child(sub(t, "History", String(history.length)));
  if (!history.length) el.child(div().text_size(12).text_color(t.dim).child("Nobody has decided it yet."));
  history.forEach((h, i) => el.child(bullet(t, `${h.at ? `${String(h.at).slice(11, 16)}  ` : ""}${h.text}`, { tone: h.tone, mark: h.tone === "done" ? "✓" : "•" }).id(`hist-${i}`)));
  const by = approver(a);
  if (a.decision === "approved" && by) el.child(div().text_size(11.5).text_color(t.dim).child(`Approved by ${by}`));
  return el;
}

// ---- Tests ----

function tests(app, t, task, detail) {
  const all = testCases(detail);
  if (!all.length) return reading(t, detail, "No test cases yet: test design has not run.");
  const judged = all.filter((c) => c.result != null);
  const el = v_flex().gap(3);
  el.child(div().pb(4).text_size(11.5).text_color(t.dim).child(`${all.length} cases${judged.length ? ` · ${judged.filter((c) => c.result).length} of ${judged.length} judged pass` : " · verifying has not judged them yet"}`));
  testGroups(task, detail).forEach((g, gi) => {
    el.child(sub(t, `${g.id ? `${g.id}  ` : ""}${g.text}`.slice(0, 160), String(g.cases.length)));
    if (!g.cases.length) el.child(div().pl(20).text_size(11.5).text_color(t.blocked).child("no test covers it"));
    g.cases.forEach((c, i) =>
      el.child(
        h_flex()
          .id(`case-${gi}-${i}`)
          .gap(8)
          .items_start()
          .py(2)
          .child(mark(t, c.result))
          .child(div().w(26).flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(c.id || "·"))
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(c.title))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child([c.type, c.layer].filter(Boolean).join(" · "))),
      ),
    );
  });
  return el;
}

// ---- Runs ----

function runs(app, t, task, detail) {
  const list = arr(detail?.stageRuns);
  if (!list.length) return reading(t, detail, "No stage ran yet.");
  const st = ownState(app, "runs");
  const picked = pickedRun(detail, st[task.id]);
  const glyph = { passed: ["✓", "done"], failed: ["✗", "error"], running: ["◐", "working"] };
  const head = [`${list.length} runs`, task.spentUsd != null ? `${money(task.spentUsd)} spent` : null].filter(Boolean).join(" · ");
  const el = v_flex().gap(2).child(div().pb(4).text_size(11.5).text_color(t.dim).child(head));
  [...list].reverse().slice(0, 80).forEach((r, i) => {
    const [g, tone] = glyph[r.status] ?? ["·", null];
    const on = r === picked;
    el.child(
      h_flex()
        .id(`run-${r.id ?? i}`)
        .gap(8)
        .items_center()
        .h(26)
        .px(6)
        .rounded(6)
        .cursor_pointer()
        .when(on, (x) => x.bg(t.selected))
        .hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => {
          st[task.id] = r.id ?? null;
          cx.notify();
        })
        .child(div().w(12).flex_none().text_color(tone ? toneColor(t, tone) : t.dim).child(g))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${stageWords(r.stage)}${r.attempt > 1 ? ` · try ${r.attempt}` : ""}`))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child([r.engine, runTook(r), money(r.costUsd), r.turns != null ? `${r.turns} turns` : null].filter(Boolean).join(" · "))),
    );
  });
  if (picked) {
    const err = runError(detail, picked);
    const files = arr(detail.artifacts).filter((a) => a.stageRunId && a.stageRunId === picked.id);
    el.child(sub(t, `${stageWords(picked.stage)} #${picked.attempt ?? 1}`, [picked.status, picked.outcome].filter(Boolean).join(" · ")));
    el.child(err ? div().p(8).rounded(7).bg(alpha(toneColor(t, "error"), 0.12)).text_size(12).text_color(toneColor(t, "error")).child(err.split("\n").slice(0, 8).join("\n")) : div().text_size(12).text_color(t.dim).child(picked.status === "running" ? "Running now." : "No error recorded."));
    arr(picked.cases).forEach((c, i) => el.child(bullet(t, s(c.title), { tone: c.ok ? "done" : "error", mark: c.ok ? "✓" : "✗" }).id(`rcase-${i}`)));
    if (files.length) {
      el.child(sub(t, "Files", String(files.length)));
      files.forEach((f, i) => el.child(h_flex().gap(8).id(`rfile-${i}`).child(div().flex_none().text_size(10.5).text_color(t.dim).child(s(f.kind))).child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(10.5).text_color(t.foreground).child(s(f.path)))));
    }
  }
  return el;
}

// ---- PR ----

function pr(app, t, task, detail) {
  const ship = detail?.ship ?? null;
  const row_ = prFor(task, app.prs);
  const url = row_?.url ?? prUrlOf(detail);
  if (!ship && !row_ && !url) return reading(t, detail, "This card has no pull request yet.");
  const el = v_flex().gap(3);
  if (row_) {
    const cs = row_.checks ?? {};
    el.child(div().text_size(13).font_semibold().text_color(t.foreground).child(`${row_.repo}#${row_.number}  ${s(row_.title)}`));
    el.child(h_flex().gap(6).flex_wrap().py(3).child(chip(t, row_.isDraft ? "draft" : "open", null, 11)).child(chip(t, `checks: ${cs.state ?? "none"}${cs.total ? ` ${cs.passed ?? 0}/${cs.total}` : ""}`, cs.state === "failure" ? "error" : cs.state === "success" ? "done" : cs.state === "pending" ? "blocked" : null, 11)).child(chip(t, `review: ${row_.reviewDecision ? String(row_.reviewDecision).toLowerCase().replaceAll("_", " ") : "none yet"}`, row_.reviewDecision === "APPROVED" ? "done" : row_.reviewDecision === "CHANGES_REQUESTED" ? "error" : null, 11)).child(chip(t, `${row_.unresolvedThreads ?? 0} open thread${row_.unresolvedThreads === 1 ? "" : "s"}`, row_.unresolvedThreads ? "blocked" : null, 11)));
    const named = arr(cs.all).length ? arr(cs.all) : arr(cs.failed);
    if (named.length) {
      el.child(sub(t, "Checks", String(named.length)));
      named.forEach((c, i) =>
        el.child(
          h_flex()
            .id(`check-${i}`)
            .gap(8)
            .items_center()
            .h(24)
            .child(div().w(12).flex_none().text_color(toneColor(t, c.state === "success" ? "done" : c.state === "pending" ? "blocked" : "error")).child(c.state === "success" ? "✓" : c.state === "pending" ? "◐" : "✗"))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(s(c.name)))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s(c.state)))
            .when(Boolean(c.url), (x) => x.child(button(t, `check-open-${i}`, "", "quiet", () => app.openUrl(c.url), { iconName: "external", small: true }))),
        ),
      );
    }
    if (row_.task) el.child(row(t, "In flight", `${plainTitle(row_.task)}${row_.task.state ? ` · ${stageWords(row_.task.state)}` : ""}`));
  }
  if (ship) {
    el.child(sub(t, "Watching", ship.ready ? "every item passes" : "waiting on the items below"));
    arr(ship.checklist).forEach((c, i) => el.child(bullet(t, `${s(c.id).replaceAll("_", " ")}${c.detail ? `: ${c.detail}` : ""}`, { tone: c.ok ? "done" : "error", mark: c.ok ? "✓" : "✗" }).id(`ship-${i}`)));
    if (ship.autoMerge) el.child(row(t, "Merge", ship.autoMerge.allowed ? `the machine will merge: ${s(ship.autoMerge.reason)}` : `a person merges, or the machine waits: ${s(ship.autoMerge.reason)}`, ship.autoMerge.allowed ? "done" : "blocked"));
    if (ship.review) el.child(row(t, "Review", ship.review.required === true ? `required${ship.review.by ? ` by ${s(ship.review.by)}` : ""}` : ship.review.required === false ? "not required here: the machine never merges without one" : "unreadable: a person merges"));
    el.child(row(t, "Fix rounds", `${ship.fixRounds ?? 0}${ship.queued ? " · in the merge queue" : ""}`));
    if (ship.lastEvent) el.child(row(t, "Last event", `${s(ship.lastEvent.class).replaceAll("_", " ")}${ship.lastEvent.at ? ` · ${ago(ship.lastEvent.at) ?? ""}` : ""}`));
  }
  if (url) el.child(div().pt(8).child(h_flex().gap(8).child(button(t, "open-pr-github", ship?.pr?.number ? `Open #${ship.pr.number} on GitHub` : "Open on GitHub", "plain", () => app.openUrl(url), { iconName: "external" }))));
  return el;
}

tab({ id: "details", label: "Overview", order: 10, render: overview });
tab({ id: "plan", label: "Plan", order: 20, count: (app, task, detail) => planCriteria(latestApproval(detail, "awaiting_approval"), task).length || null, render: plan });
tab({ id: "tests", label: "Tests", order: 30, count: (app, task, detail) => testCases(detail).length || null, render: tests });
tab({ id: "runs", label: "Runs", order: 40, count: (app, task, detail) => detail?.stageRuns?.length, render: runs });
tab({ id: "pr", label: "PR", order: 70, render: pr });
