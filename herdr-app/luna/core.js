// The pages every build has: the board and the PRs. Feature files add theirs the same way.
import { boardPage } from "./board.js";
import { prBadge, prsKey, prsMessage, prsPage } from "./prs.js";
import { prInspector } from "./pr-inspector.js";
import { boardKey } from "./boardkeys.js";
import { COMMANDS, page } from "./registry.js";

page({ id: "board", label: "Board", icon: "board", group: "work", render: boardPage, key: boardKey });
page({
  id: "prs",
  label: "Pull requests",
  icon: "pr",
  group: "work",
  render: prsPage,
  side: prInspector,
  key: prsKey,
  // The TUI's count (review requested, ready to merge, CI failed, changes requested), and a notice when a split gains a PR.
  badge: prBadge,
  onMessage: prsMessage,
});

COMMANDS.board = (app, _arg, cx) => app.go("board", cx);
COMMANDS.prs = (app, _arg, cx) => app.go("prs", cx);
// `pr owner/name#7` opens that PR in the PR page's panel (bare: the selected one), for keys, the palette and scripts.
COMMANDS.pr = (app, arg, cx) => {
  app.go("prs", cx);
  const want = String(arg ?? "").trim();
  if (want) {
    const all = [app.prs.inbox, app.prs.all].filter(Boolean).flatMap((s) => s.prs ?? []);
    const hit = all.find((p) => `${p.repo}#${p.number}` === want);
    if (!hit) {
      app.say(`no open PR ${want} in the lists`, "error");
      return cx.notify();
    }
    if (!(app.prs.inbox?.prs ?? []).some((p) => p === hit)) app.showPrList("all", cx);
    app.prSplit = null;
    app.prSel = want;
  }
  app.prPanel = true;
  cx.notify();
};
