// The dialogs the board's marks and the PR page ask with: a bulk action over a list of tickets
// (it runs the calls one by one and says how many went through) and closing a PR unmerged.
// The result goes back to the board through shared state (`luna.bulk`, read by takeShared).
import { div } from "gpui-kit";
import { setShared } from "herdr";

import { bulkResult } from "./controls.js";
import { option } from "./dialogs.js";
import { ARCHIVE_REASONS } from "./model.js";
import { DIALOGS } from "./registry.js";
import { mono } from "./ui.js";

const STEPS = {
  start: (m, id) => m.start(id),
  resume: (m, id) => m.resume(id),
  approve: (m, id) => m.decide(id, "approved"),
  abort: (m, id) => m.abort(id),
  delete: (m, id) => m.remove(id),
  worktree: (m, id) => m.post(`/tasks/${encodeURIComponent(id)}/worktree/remove`, {}),
  archive: (m, id, reason) => m.archive(id, reason),
};

/** Runs the calls one by one (a refused one is counted, not fatal) and leaves the result for the board. */
export async function runBulk(app, d, reason = null) {
  const done = [];
  let failed = 0;
  let last = null;
  for (const item of d.items ?? []) {
    try {
      await STEPS[item.step ?? d.action](app.machine, item.id, reason);
      done.push(item.id);
    } catch (e) {
      failed++;
      last = e?.message ?? String(e);
    }
  }
  const total = (d.items ?? []).length;
  const text = `${bulkResult(d.action, done.length, total, failed)}${last ? `: ${last}` : ""}`;
  setShared("luna.bulk", { done, text, failed, at: Date.now() });
  return null;
}

DIALOGS.bulk = {
  title: "Are you sure?",
  height: 320,
  body: (app, t, d) => {
    const out = [div().pt(8).pb(8).text_size(12.5).text_color(t.foreground).child(d.question ?? "")];
    for (const item of (d.items ?? []).slice(0, 8)) out.push(div().h(24).truncate().text_size(12).text_color(t.muted).child(`${item.step === "approve" ? "approve" : item.step === "start" ? "start" : item.step === "resume" ? "resume" : "·"}  ${item.title}`));
    if ((d.items ?? []).length > 8) out.push(div().h(24).text_size(12).text_color(t.dim).child(`and ${d.items.length - 8} more`));
    if (d.skipped > 0) out.push(div().pt(8).text_size(11.5).text_color(t.dim).child(`${d.skipped} marked ticket${d.skipped === 1 ? "" : "s"} cannot take this and ${d.skipped === 1 ? "is" : "are"} left alone.`));
    if (d.action === "archive") {
      for (const [id, words] of ARCHIVE_REASONS) out.push(option(t, `bulk-ar-${id}`, words, false, (_e, cx) => app.send(cx, () => runBulk(app, d, id))));
    }
    return out;
  },
  primary: (app, d) => (d.action === "archive" ? null : { label: d.action === "approve" ? "Go on" : d.action === "abort" ? "Stop them" : d.action === "worktree" ? "Remove" : "Delete", kind: d.action === "approve" ? "primary" : "danger" }),
  submit: (app, cx, d) => app.send(cx, () => runBulk(app, d)),
};

DIALOGS.close_pr = {
  title: "Close the pull request",
  height: 240,
  body: (app, t, d) => [
    div().pt(8).text_size(12.5).text_color(t.foreground).child(`${d.repo}#${d.number} closes without merging. Its branch stays.`),
    div().pt(8).font_family(mono()).text_size(11).text_color(t.dim).child(d.subtitle ?? ""),
  ],
  primary: () => ({ label: "Close the PR", kind: "danger" }),
  submit: (app, cx, d) =>
    app.send(cx, async () => {
      try {
        await app.machine.post(`/github/prs/${d.repo}/${d.number}/close`, {});
      } catch (e) {
        if (e?.code === "pr_busy") throw new Error("A task is running for this PR. Stop it first (its card's Stop), then close the PR.");
        if (e?.code === "no_pull") throw new Error("The machine no longer lists this PR: refresh the list.");
        throw e;
      }
      setShared("luna.bulk", { done: [], text: `Closed ${d.repo}#${d.number}`, failed: 0, refreshPrs: true, at: Date.now() });
      return null;
    }),
};
