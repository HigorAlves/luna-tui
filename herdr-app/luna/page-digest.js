// The Digest: what changed since you last had the board open, by group (Shipped, Escalated, Needs
// you, Closed), newest first. "Last time" is the moment this pane was last alive: the pane keeps
// the time in localStorage while it runs, and the Digest reads it once when the pane starts. A
// first run (nothing kept) shows every ticket that has a group, as the TUI does.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

import { ago, cardLine } from "./model.js";
import { COMMANDS, page } from "./registry.js";
import { chip, spinner } from "./ui.js";
import { DIGEST_GROUPS, digestEntries, isNew, ticketLink } from "./views-model.js";
import { ticketRow } from "./page-inbox.js";
import { button, frame, note, section } from "./views-ui.js";

const KEY = "luna.lastSeen";
const TOUCH_EVERY_MS = 60 * 1000;

function readMark() {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeMark(ms) {
  try {
    localStorage.setItem(KEY, String(ms));
  } catch {
    // not kept: the next start shows everything
  }
}

/** This pane's digest state: `since` is read once, from the mark the last run left; the mark is kept fresh as the pane lives. */
export function digestState(app, now = Date.now()) {
  const st = app.state("digest");
  if (!st.started) {
    st.started = true;
    st.since = readMark();
    st.touched = 0;
  }
  if (now - st.touched > TOUCH_EVERY_MS) {
    st.touched = now;
    writeMark(now);
  }
  return st;
}

function digestPage(app, t) {
  const now = Date.now();
  const st = digestState(app, now);
  const tasks = app.tasks ?? [];
  const entries = digestEntries(tasks, st.since);
  const offline = !app.loaded && app.link === "offline";
  const links = [app.prs?.inbox?.prs, app.prs?.all?.prs].flat().filter(Boolean);
  const when = st.since == null ? "This is the first time: everything with news" : `Since ${ago(new Date(st.since).toISOString())?.replace(" ago", "") ?? "—"} ago`;
  const body = [];
  if (!app.loaded && !offline) body.push(h_flex().gap(8).p(12).text_color(t.dim).child(spinner(t, 13)).child("Reading the board…"));
  if (app.loaded && entries.length === 0) body.push(note(t, "Nothing changed since you last looked."));
  for (const [id, label] of DIGEST_GROUPS) {
    const group = entries.filter((e) => e.group === id);
    if (!group.length) continue;
    body.push(section(t, `${label} · ${group.length}`));
    for (const { task } of group) {
      const link = ticketLink(task, links);
      body.push(
        ticketRow(app, t, task, {
          actions: false,
          extra: [
            ...(link ? [button(t, `dg-open-${task.id}`, "Open link", "plain", () => app.openUrl(link), { small: true, iconName: "external" })] : []),
          ],
        }),
      );
    }
  }
  return frame(app, t, {
    id: "digest-list",
    title: "Digest",
    summary: offline ? app.error ?? "The machine does not answer" : `${when} · ${entries.length} change${entries.length === 1 ? "" : "s"}`,
    error: offline,
    actions: [
      button(
        t,
        "digest-seen",
        "Mark all seen",
        "plain",
        (_e, cx) => {
          st.since = Date.now();
          writeMark(st.since);
          cx.notify();
        },
        { small: true, iconName: "check" },
      ),
    ],
    body,
  });
}

page({
  id: "digest",
  label: "Digest",
  icon: "clock",
  group: "inbox",
  render: digestPage,
  badge: (app) => {
    const st = digestState(app);
    const n = digestEntries(app.tasks ?? [], st.since).filter((e) => st.since == null || isNew(e.task, st.since)).length;
    return n && st.since != null ? { n, tone: null } : null;
  },
});

COMMANDS.digest = (app, _arg, cx) => app.go("digest", cx);
