// The tabs a ticket has only in some states, after the TUI's pages: Now (a running card: its
// scenarios, budget and checkpoint), Stopped (why it stopped), Result (a shipped one), and the
// Build and Verify reports. Each has a `when`, so the inspector lists it only where it applies.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { escalationWords, stageWords } from "./model.js";
import { bullet, codeBlock, markdown, sub } from "./inspector.js";
import { mono, toneColor } from "./ui.js";
import { tab } from "./registry.js";
import { note } from "./tabs-detail.js";
import { buildProgressView, buildReportView, isResult, isRunning, isStopped, resultView, runningLine, stoppedView, verifyReportView } from "./detail-sections.js";

const fact = (t, label, value, tone = null) =>
  h_flex()
    .gap(10)
    .items_start()
    .py(2)
    .child(div().w(84).flex_none().text_size(11).text_color(t.dim).child(label))
    .child(div().flex_1().min_w(0).text_size(12).text_color(tone ? toneColor(t, tone) : t.foreground).child(value));

const bar = (t, pct) => {
  const full = 110;
  const tone = pct >= 0.8 ? toneColor(t, "blocked") : t.accent;
  return div().w(full).h(6).flex_none().rounded(3).bg(t.hover).child(div().w(Math.max(2, Math.round(full * pct))).h(6).rounded(3).bg(tone));
};

// ---- Now ----

function now(app, t, task, detail) {
  const el = v_flex().gap(3);
  el.child(fact(t, "Stage", runningLine(task, detail, stageWords)));
  if (!detail) return el.child(note(t, "Reading…"));
  const p = buildProgressView(detail);
  if (p) {
    el.child(sub(t, "Build", p.scenarios.length ? `${p.green} of ${p.scenarios.length} green` : null));
    if (!p.scenarios.length) el.child(div().text_size(12).text_color(t.dim).child("No scenario has reported yet."));
    p.scenarios.forEach((s, i) =>
      el.child(
        h_flex()
          .id(`scn-${i}`)
          .gap(8)
          .items_center()
          .h(22)
          .child(div().w(12).flex_none().text_color(s.green ? toneColor(t, "done") : t.dim).child(s.green ? "●" : "○"))
          .child(div().w(70).flex_none().truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(s.id))
          .child(div().text_size(11.5).text_color(s.green ? toneColor(t, "done") : t.muted).child(s.state || "red")),
      ),
    );
    el.child(sub(t, "Budget"));
    p.budget.forEach((b, i) =>
      el.child(
        h_flex()
          .id(`budget-${i}`)
          .gap(10)
          .items_center()
          .h(22)
          .child(div().w(84).flex_none().text_size(11).text_color(t.dim).child(b.label))
          .when(b.pct != null, (x) => x.child(bar(t, b.pct)))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(b.pct != null && b.pct >= 0.8 ? toneColor(t, "blocked") : t.foreground).child(b.text)),
      ),
    );
    if (p.checkpoint) el.child(fact(t, "Checkpoint", p.checkpoint));
  } else {
    el.child(div().pt(6).text_size(12).text_color(t.dim).child("This stage reports no build progress."));
  }
  const events = [...(detail.events ?? [])].slice(-5).reverse();
  el.child(sub(t, "Latest activity", "the Activity tab has all of it"));
  if (!events.length) el.child(div().text_size(12).text_color(t.dim).child("Nothing yet."));
  events.forEach((e, i) => el.child(div().id(`now-ev-${i}`).text_size(11.5).text_color(t.muted).truncate().child(`${String(e.kind ?? "").replace(/^stage\./, "").replaceAll(".", " ").replaceAll("_", " ")}`)));
  return el;
}

// ---- Stopped ----

function stopped(app, t, task, detail) {
  const v = stoppedView(task, detail, escalationWords);
  const el = v_flex().gap(3);
  el.child(div().text_size(13).font_semibold().text_color(toneColor(t, "error")).child(`✗ ${stageWords(task.state)}${v.label ? ` · ${v.label}` : v.sentence ? ` · ${v.sentence}` : ""}`));
  if (v.label && v.sentence) el.child(div().pl(2).text_size(12).text_color(t.foreground).child(v.sentence));
  if (v.how.length) el.child(div().text_size(11.5).text_color(t.muted).child(v.how.join(" · ")));
  if (v.agentSaid) el.child(div().text_size(11.5).text_color(t.muted).child(`the agent said: ${v.agentSaid}`));
  if (v.corrected) el.child(div().text_size(11.5).text_color(toneColor(t, "done")).child(`corrected to: ${v.corrected}`));
  if (v.summary) el.child(sub(t, "Summary")).child(markdown(`stop-sum-${task.id}`, v.summary));
  if (!detail) el.child(note(t, "Reading…"));
  if (v.tail) el.child(sub(t, "Output")).child(codeBlock(t, v.tail.slice(-1600)));
  if (v.sandbox) el.child(sub(t, "Sandbox", "kept")).child(div().text_size(11.5).font_family(mono()).text_color(t.muted).child(`${v.sandbox.path}${v.sandbox.until ? ` until ${v.sandbox.until}` : ""}`));
  if (detail && !v.tail && !v.summary && !v.label && !v.sentence) el.child(note(t, "The machine recorded no reason."));
  return el;
}

// ---- Result ----

function result(app, t, task, detail) {
  if (!detail) return note(t, "Reading…");
  const v = resultView(task, detail);
  const el = v_flex().gap(3);
  if (v.release) {
    el.child(div().text_size(12.5).font_semibold().text_color(v.release.high ? toneColor(t, "blocked") : t.foreground).child(`${v.release.high ? "⚑ release owner: " : "Release question: "}${v.release.question}`));
    v.release.checklist.forEach((c, i) => el.child(bullet(t, c.text, { tone: c.ok ? "done" : "error", mark: c.ok ? "✓" : "✗" }).id(`rel-${i}`)));
  }
  if (v.summary) {
    el.child(sub(t, "Summary"));
    if (v.summary.what) el.child(markdown(`res-what-${task.id}`, v.summary.what));
    if (v.summary.why) el.child(fact(t, "Why", v.summary.why));
  }
  if (v.findings.length) {
    el.child(sub(t, "Open findings", v.findings.map((g) => `${g.items.length} ${g.name}`).join(" · ")));
    v.findings.forEach((g) =>
      g.items.forEach((f, i) =>
        el.child(
          v_flex()
            .id(`res-f-${g.id}-${i}`)
            .gap(1)
            .py(2)
            .child(bullet(t, `${g.name}  ·  ${f.title ?? ""}`, { tone: g.id === "blocker" ? "error" : null, mark: g.id === "blocker" ? "✗" : "•" }))
            .when(Boolean(f.path), (x) => x.child(div().pl(20).truncate().font_family(mono()).text_size(10.5).text_color(t.dim).child(`${f.path}${f.line ? `:${f.line}` : ""}`))),
        ),
      ),
    );
  }
  if (v.artifacts) el.child(fact(t, "Evidence", `${v.artifacts} file${v.artifacts === 1 ? "" : "s"}: the Evidence tab opens them`));
  if (!v.release && !v.summary && !v.findings.length && !v.artifacts) el.child(note(t, "No summary was recorded for this ticket."));
  return el;
}

// ---- Build and Verify reports ----

const resultGlyph = (r) => ({ pass: ["✓", "done"], passed: ["✓", "done"], fail: ["✗", "error"], failed: ["✗", "error"], partial: ["◐", "blocked"] })[r] ?? ["○", null];

function reports(app, t, task, detail) {
  const b = buildReportView(detail);
  const v = verifyReportView(detail);
  if (!b && !v) return note(t, detail ? "No report yet: Build and Verify write one each." : "Reading…");
  const el = v_flex().gap(3);
  if (b) {
    el.child(sub(t, "Build report", b.head ? `${b.branch ?? ""} @ ${b.head}`.trim() : null));
    [["Base", b.base], ["Iterations", b.iterations], ["Scenarios", b.scenarios], ["Tokens", b.tokens], ["Minutes", b.minutes]].forEach(([k, val]) => val && el.child(fact(t, k, val)));
    if (b.summary?.what) el.child(markdown(`bld-what-${task.id}`, b.summary.what));
    if (b.summary?.why) el.child(fact(t, "Why", b.summary.why));
    if (b.diff) el.child(fact(t, "Diff", `+${b.diff.added ?? 0} −${b.diff.removed ?? 0} in ${b.diff.files.length} file${b.diff.files.length === 1 ? "" : "s"}`));
    b.diff?.files.slice(0, 20).forEach((f, i) => el.child(div().id(`bld-file-${i}`).pl(94).truncate().font_family(mono()).text_size(10.5).text_color(t.muted).child(f)));
    if (b.testsStep) el.child(fact(t, "Tests first", [b.testsStep.status, b.testsStep.note].filter(Boolean).join(": ") || "no word"));
    if (b.sweep) el.child(fact(t, "Sweep", [b.sweep.status, b.sweep.ran.length ? `ran ${b.sweep.ran.join(", ")}` : null, b.sweep.note].filter(Boolean).join(": ")));
    if (b.scope) {
      el.child(fact(t, "Scope check", b.scope.clean ? "clean" : `${b.scope.issues.length} issue${b.scope.issues.length === 1 ? "" : "s"}`, b.scope.clean ? "done" : "error"));
      b.scope.issues.slice(0, 10).forEach((i, n) => el.child(bullet(t, `${i.severity ? `${i.severity}  ·  ` : ""}${i.text}`, { tone: "error", mark: "✗" }).id(`bld-scope-${n}`)));
    }
    if (b.runs.length) {
      el.child(sub(t, "Runs", String(b.runs.length)));
      b.runs.slice(-12).forEach((r, i) =>
        el.child(
          h_flex()
            .id(`bld-run-${i}`)
            .gap(8)
            .h(22)
            .items_center()
            .child(div().w(30).flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(`#${r.attempt ?? "?"}`))
            .child(div().w(70).flex_none().text_size(11.5).text_color(r.outcome === "pass" ? toneColor(t, "done") : toneColor(t, "blocked")).child(r.outcome))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child([r.engine, r.took].filter(Boolean).join(" · "))),
        ),
      );
    }
  }
  if (v) {
    el.child(sub(t, "Verify report", [v.pr ? `PR #${v.pr}` : null, v.head].filter(Boolean).join(" @ ") || null));
    if (v.tests) el.child(fact(t, "Tests", v.tests, v.testsOk ? "done" : "error"));
    [["Coverage", v.coverageDelta != null ? `${v.coverageDelta > 0 ? "+" : ""}${v.coverageDelta} points` : null], ["Review", v.review], ["Mutation", v.mutation], ["CI", v.ciClass], ["Rounds", v.rounds], ["Environment", v.env]].forEach(([k, val]) => val && el.child(fact(t, k, val)));
    v.overrides.forEach((o, i) => el.child(bullet(t, o, { tone: "blocked", mark: "⚑" }).id(`ver-ov-${i}`)));
    if (v.e2e) {
      el.child(sub(t, "Browser run", v.e2e.verdict ?? "no verdict"));
      v.e2e.rows.slice(0, 40).forEach((r, i) => {
        const [g, tone] = resultGlyph(r.result);
        el.child(
          v_flex()
            .id(`ver-e2e-${i}`)
            .gap(1)
            .py(2)
            .child(bullet(t, `${r.id ? `${r.id}  ` : ""}${r.title}`, { tone, mark: g }))
            .when(Boolean(r.seen), (x) => x.child(div().pl(20).text_size(11).text_color(t.muted).child(r.seen.slice(0, 240))))
            .when(r.artifacts.length > 0, (x) => x.child(div().pl(20).truncate().font_family(mono()).text_size(10.5).text_color(t.dim).child(r.artifacts.join(", ")))),
        );
      });
      if (!v.e2e.rows.length) el.child(div().text_size(12).text_color(t.dim).child("No scenario was run in a browser."));
    }
    if (v.findings.length) {
      el.child(sub(t, "Findings", String(v.findings.length)));
      v.findings.slice(0, 40).forEach((f, i) =>
        el.child(
          v_flex()
            .id(`ver-f-${i}`)
            .gap(1)
            .py(2)
            .child(bullet(t, `${f.level.replace("_", " ")}  ·  ${f.title}${f.criterion ? `  ·  ${f.criterion}` : ""}`, { tone: f.resolution ? "done" : f.level === "blocker" ? "error" : null, mark: f.resolution ? "✓" : f.level === "blocker" ? "✗" : "•" }))
            .child(div().pl(20).truncate().text_size(10.5).text_color(t.dim).child([f.resolution, f.place].filter(Boolean).join("  ·  ") || "open")),
        ),
      );
    }
  }
  return el;
}

const reportsExist = (app, task, detail) => Boolean(detail?.reports?.build || detail?.reports?.verify);

tab({ id: "now", label: "Now", order: 5, when: (app, task) => isRunning(task), render: now });
tab({ id: "stopped", label: "Stopped", order: 5, when: (app, task) => isStopped(task), render: stopped });
tab({ id: "result", label: "Result", order: 6, when: (app, task) => isResult(task), render: result });
tab({
  id: "reports",
  label: "Reports",
  order: 35,
  when: reportsExist,
  count: (app, task, detail) => [detail?.reports?.build, detail?.reports?.verify].filter(Boolean).length || null,
  render: reports,
});
