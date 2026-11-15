// The pages every build has: the board and the PRs. Feature files add theirs the same way.
import { boardPage } from "./board.js";
import { prBadge, prsKey, prsMessage, prsPage } from "./prs.js";
import { boardKey } from "./boardkeys.js";
import { COMMANDS, page } from "./registry.js";

page({ id: "board", label: "Board", icon: "board", group: "work", render: boardPage, key: boardKey });
page({
  id: "prs",
  label: "Pull requests",
  icon: "pr",
  group: "work",
  render: prsPage,
  key: prsKey,
  // The TUI's count (review requested, ready to merge, CI failed, changes requested), and a notice when a split gains a PR.
  badge: prBadge,
  onMessage: prsMessage,
});

COMMANDS.board = (app, _arg, cx) => app.go("board", cx);
COMMANDS.prs = (app, _arg, cx) => app.go("prs", cx);
