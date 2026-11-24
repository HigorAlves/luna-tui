// The PR inbox.
import { CloneInput, PrActionInput } from "@hardness/contracts";
import { TaskNotFoundError } from "../../../application/pipeline.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { body, prParams, type RouteDeps } from "./kit.ts";

export function githubRoutes(deps: RouteDeps) {
  const { pulls, prTasks, serialize } = deps;
  const app = createOpenApiRouter();
  if (pulls) {
    // The PR inbox: what the last poll saw, a poll on demand, a merge, and a clone for a repo
    // the machine has no checkout of. Actions on a PR are `POST .../actions` (pr-tasks).
    app.get("/github/prs", (c) => c.json(pulls.snapshot));
    app.post("/github/prs/refresh", async (c) => c.json(await pulls.pollOnce()));
    // Every open PR in the repos you can reach, polled on its own slower cadence. These two sit before the `:owner/:name` routes so "all" is never read as an owner.
    app.get("/github/prs/all", (c) => c.json(pulls.all));
    // The refresh starts a poll in the background (one at a time) and answers 202 with the list as it stands; the fresh list arrives as a `github.prs.all` event.
    app.post("/github/prs/all/refresh", (c) => c.json(pulls.refreshAll(), 202));
    app.post("/github/prs/:owner/:name/:number/merge", async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.merge(`${owner}/${name}`, number);
      return c.json({ merged: true });
    });
    app.post("/github/prs/:owner/:name/:number/close", async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.close(`${owner}/${name}`, number);
      return c.json({ closed: true });
    });
    if (prTasks) {
      app.post("/github/prs/:owner/:name/:number/actions", async (c) => {
        const { owner, name, number } = prParams(c);
        const { action } = await body(c, PrActionInput);
        const slug = `${owner}/${name}`.toLowerCase();
        // The inbox first, then the all-list: the All repos tab dispatches on PRs the inbox does not hold.
        const pr = [...pulls.snapshot.prs, ...pulls.all.prs].find((p) => p.repo.toLowerCase() === slug && p.number === number);
        if (!pr) throw new TaskNotFoundError(`${owner}/${name}#${number}`);
        return c.json(await serialize(await prTasks.dispatch(pr, action)), 201);
      });
    }
    app.post("/github/clone", async (c) => {
      const { repo, dest } = await body(c, CloneInput);
      await pulls.clone(repo, dest);
      return c.json({ repo, dest, cloning: true }, 202);
    });
  }
  return app;
}
