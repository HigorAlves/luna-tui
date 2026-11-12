// The Evidence tab: the Evidence Pack, then every artifact the stages produced, by run.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec } from "herdr";

import { stageWords } from "./model.js";
import { bullet, markdown, sub } from "./inspector.js";
import { button, chip, mono } from "./ui.js";
import { tab } from "./registry.js";
import { artifactGroups, dirOf, runTook } from "./detail-model.js";
import { note } from "./tabs-detail.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const s = (v) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? v.text ?? v.title ?? JSON.stringify(v) : String(v));
const open = (what) => what && exec("open", [what]).catch(() => null);
const isUrl = (x) => /^https?:\/\//i.test(s(x));
const passed = (r) => r === "pass" || r === "passed";
const failed = (r) => r === "fail" || r === "failed";

function evidence(app, t, task, detail) {
  const ev = task.evidence ?? null;
  const groups = artifactGroups(detail);
  if (!ev && !groups.length) return note(t, detail ? "No evidence yet: nothing has produced a file." : "Reading…");
  const el = v_flex().gap(3);
  if (ev) {
    el.child(
      h_flex()
        .gap(6)
        .items_center()
        .flex_wrap()
        .child(chip(t, ev.format ?? "evidence", null, 11))
        .when(ev.published != null, (x) => x.child(chip(t, ev.published ? "published" : "not published", ev.published ? "done" : null, 11)))
        .when(Boolean(ev.risk), (x) => x.child(chip(t, `${s(ev.risk)} risk`, null, 11))),
    );
    if (ev.summary) el.child(sub(t, "Summary")).child(markdown(`evsum-${task.id}`, s(ev.summary)));
    const r = ev.results ?? {};
    const counts = ["unit", "integration", "e2e"].filter((k) => r[k] && (r[k].total != null || r[k].verdict)).map((k) => `${k} ${r[k].verdict ?? `${r[k].passed ?? 0}/${r[k].total}`}`);
    if (counts.length) el.child(div().pt(4).text_size(11.5).text_color(t.dim).child(counts.join(" · ")));
    const scenarios = arr(ev.scenarios);
    if (scenarios.length) {
      el.child(sub(t, "Scenarios", String(scenarios.length)));
      scenarios.forEach((c, i) => el.child(bullet(t, s(c.text ?? c), { tone: passed(c.result) ? "done" : failed(c.result) ? "error" : null, mark: passed(c.result) ? "✓" : failed(c.result) ? "✗" : "–" }).id(`ev-sc-${i}`)));
    }
    const findings = arr(ev.findingsDetail).length ? arr(ev.findingsDetail) : arr(ev.findings);
    if (findings.length) {
      el.child(sub(t, "Findings", String(findings.length)));
      findings.forEach((f, i) =>
        el.child(bullet(t, `${s(f.title ?? f)}${f.severity ? `  ·  ${f.severity}` : ""}${f.resolution ? `  ·  ${s(f.resolution)}` : ""}`, { tone: f.resolution === "fixed" ? "done" : f.severity === "blocker" ? "error" : null, mark: f.resolution === "fixed" ? "✓" : "•" }).id(`ev-f-${i}`)),
      );
    }
    const media = arr(ev.media);
    if (media.length) {
      el.child(sub(t, "Media", String(media.length)));
      media.forEach((m, i) =>
        el.child(
          h_flex()
            .id(`media-${i}`)
            .gap(8)
            .items_center()
            .h(26)
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(s(m.label ?? m.localPath ?? m.url ?? "media")))
            .when(Boolean(m.localPath), (x) => x.child(button(t, `media-file-${i}`, "Open", "plain", () => open(m.localPath), { small: true })))
            .when(isUrl(m.url), (x) => x.child(button(t, `media-url-${i}`, "URL", "quiet", () => app.openUrl(m.url), { small: true, iconName: "external" }))),
        ),
      );
    }
    if (ev.video) el.child(div().pt(4).text_size(12).text_color(t.foreground).child(`Video verdict: ${s(ev.video.verdict ?? "none")}`));
    if (ev.howToVerify) el.child(sub(t, "How to verify")).child(markdown(`evhow-${task.id}`, s(ev.howToVerify)));
    if (ev.rollback) el.child(sub(t, "Rollback")).child(div().text_size(12).text_color(t.foreground).child(s(ev.rollback)));
  }
  groups.forEach((g, gi) => {
    const where = g.run ? `${stageWords(g.run.stage)} #${g.run.attempt ?? 1}` : "Other files";
    el.child(sub(t, where, `${g.files.length} file${g.files.length === 1 ? "" : "s"}${g.run ? ` · ${[g.run.status, runTook(g.run)].filter(Boolean).join(" · ")}` : ""}`));
    g.files.forEach((a, i) =>
      el.child(
        h_flex()
          .id(`art-${gi}-${i}`)
          .gap(8)
          .items_center()
          .h(26)
          .child(div().w(60).flex_none().text_size(10.5).text_color(t.dim).truncate().child(s(a.kind)))
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.foreground).child(s(a.label ?? a.path)))
          .child(button(t, `art-open-${gi}-${i}`, "Open", "plain", () => open(a.path), { small: true }))
          .child(button(t, `art-dir-${gi}-${i}`, "Folder", "quiet", () => open(dirOf(a.path)), { small: true, busy: !dirOf(a.path) })),
      ),
    );
  });
  if (!groups.length && ev) el.child(div().pt(6).text_size(12).text_color(t.dim).child("No stage left a file."));
  return el;
}

tab({ id: "evidence", label: "Evidence", order: 55, count: (app, task, detail) => detail?.artifacts?.length || null, render: evidence });
