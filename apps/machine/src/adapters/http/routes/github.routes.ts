// The PR inbox.
import { TaskNotFoundError } from "../../../application/pipeline.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { dirname } from "node:path";

import { allPrsRoute, cloneRoute, closePrRoute, lookupPrRoute, mergePrRoute, openPrRoute, prActionRoute, prDetailRoute, prsRoute, readyPrRoute, refreshAllPrsRoute, refreshPrsRoute, searchIssuesRoute } from "./github.openapi.ts";
import { prParams, type RouteDeps } from "./kit.ts";

export function githubRoutes(deps: RouteDeps) {
  const { pulls, prTasks, prDesk, serialize } = deps;
  const app = createOpenApiRouter();
  if (pulls) {
    // The PR inbox: what the last poll saw, a poll on demand, a merge, and a clone for a repo
    // the machine has no checkout of. Actions on a PR are `POST .../actions` (pr-tasks).
    app.openapi(prsRoute, (c) => c.json(pulls.snapshot, 200));
    app.openapi(refreshPrsRoute, async (c) => c.json(await pulls.pollOnce(), 200));
    // Every open PR in the repos you can reach, polled on its own slower cadence. These two sit before the `:owner/:name` routes so "all" is never read as an owner.
    app.openapi(allPrsRoute, (c) => c.json(pulls.all, 200));
    // The refresh starts a poll in the background (one at a time) and answers 202 with the list as it stands; the fresh list arrives as a `github.prs.all` event.
    app.openapi(refreshAllPrsRoute, (c) => c.json(pulls.refreshAll(), 202));
    app.openapi(mergePrRoute, async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.merge(`${owner}/${name}`, number);
      return c.json({ merged: true as const }, 200);
    });
    app.openapi(closePrRoute, async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.close(`${owner}/${name}`, number);
      return c.json({ closed: true as const }, 200);
    });
    if (prTasks) {
      app.openapi(prActionRoute, async (c) => {
        const { owner, name, number } = prParams(c);
        const { action } = c.req.valid("json");
        const slug = `${owner}/${name}`.toLowerCase();
        // The inbox first, then the all-list: the All repos tab dispatches on PRs the inbox does not hold.
        const pr = [...pulls.snapshot.prs, ...pulls.all.prs].find((p) => p.repo.toLowerCase() === slug && p.number === number);
        if (!pr) throw new TaskNotFoundError(`${owner}/${name}#${number}`);
        return c.json(await serialize(await prTasks.dispatch(pr, action)), 201);
      });
    }
    app.openapi(cloneRoute, async (c) => {
      const { repo, dest } = c.req.valid("json");
      // The folder must be one the machine sees: a clone anywhere else lands only inside its container.
      if (prDesk) await prDesk.inside(dirname(dest));
      await pulls.clone(repo, dest);
      return c.json({ repo, dest, cloning: true as const }, 202);
    });
  }
  if (prDesk) {
    // One PR on demand, beside the inbox: a client's PR tab, Ready for review, a branch's PR, @-mention search, push and open.
    app.openapi(lookupPrRoute, async (c) => {
      const { repo, branch } = c.req.valid("query");
      return c.json({ pr: await prDesk.lookup(repo, branch) }, 200);
    });
    app.openapi(searchIssuesRoute, async (c) => {
      const { repo, kind, q } = c.req.valid("query");
      return c.json({ items: await prDesk.search(repo, kind, q) }, 200);
    });
    app.openapi(openPrRoute, async (c) => c.json(await prDesk.openPr(c.req.valid("json")), 201));
    app.openapi(prDetailRoute, async (c) => {
      const { owner, name, number } = prParams(c);
      return c.json(await prDesk.detail(`${owner}/${name}`, number), 200);
    });
    app.openapi(readyPrRoute, async (c) => {
      const { owner, name, number } = prParams(c);
      await prDesk.ready(`${owner}/${name}`, number);
      return c.json({ ready: true as const }, 200);
    });
  }
  return app;
}
