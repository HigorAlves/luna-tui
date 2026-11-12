// The pages every build has: the board and the PRs. Feature files add theirs the same way.
import { boardPage } from "./board.js";
import { prsPage } from "./prs.js";
import { COMMANDS, page } from "./registry.js";

page({ id: "board", label: "Board", icon: "board", group: "work", render: boardPage });
page({
  id: "prs",
  label: "Pull requests",
  icon: "pr",
  group: "work",
  render: prsPage,
  badge: (app) => {
    const n = (app.prs.inbox?.prs ?? []).filter((p) => p.split === "review_requested").length;
    return n ? { n, tone: null } : null;
  },
});

COMMANDS.board = (app, _arg, cx) => app.go("board", cx);
COMMANDS.prs = (app, _arg, cx) => app.go("prs", cx);
