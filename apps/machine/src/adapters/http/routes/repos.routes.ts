// Repositories: health, base approval, setup, config proposals and the luna.yaml checks.
import { isAbsolute, resolve as resolvePath } from "node:path";
import { checkLunaConfigText } from "../../../domain/luna-config.ts";
import { proposalSkips, proposeConfig } from "../../../domain/config-proposal.ts";
import { PolicyParseError } from "../../../domain/policy.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { BadRequest, SIGNAL_DAYS, DAY_MS, fail, type RouteDeps } from "./kit.ts";
import { approveBaseRoute, checkConfigRoute, listReposRoute, proofJobRoute, proposalsRoute, proveConfigRoute, setupRepoRoute } from "./repos.openapi.ts";

export function reposRoutes(deps: RouteDeps) {
  const { repoHealth, approveBase, pipeline, bus, runs, configProofs, repoSignals, knownRepos, clock, serialize } = deps;
  const app = createOpenApiRouter();
  app.openapi(listReposRoute, async (c) => c.json((await repoHealth?.()) ?? [], 200));

  if (approveBase) {
    // A base runs the stage's process and can read its credential: a person approves the exact reference, here, and only for the base the repository names now.
    app.openapi(approveBaseRoute, async (c) => {
      // The body is read by hand: whatever it holds, a wrong shape is the one 400 below.
      const body = (c.req.valid("json") ?? null) as { repo?: unknown; base?: unknown } | null;
      if (typeof body?.repo !== "string" || typeof body.base !== "string" || !body.repo || !body.base) throw new BadRequest("repo and base are required");
      const result = await approveBase(body.repo, body.base);
      if (!result.ok) throw new BadRequest(result.reason);
      return c.json({ repo: body.repo, base: body.base, approved: true as const }, 200);
    });
  }

  app.openapi(setupRepoRoute, async (c) => {
    const { repoPath } = c.req.valid("json");
    return c.json(await serialize(await pipeline.setupRepo(repoPath)), 201);
  });

  // A config proposal: the scorecards come in the body, the repo's luna.yaml and its own run signals are read here, a fixed rule picks the
  // changes (domain/config-proposal.ts), and a non-empty result waits at the setup gate as a `config` card.
  app.openapi(proposalsRoute, async (c) => {
    const { repo: given, candidates } = c.req.valid("json");
    if (!isAbsolute(given)) throw new BadRequest("repo must be an absolute path");
    // Approving the card writes luna.yaml into this path, so it is the normalised path of a repo the machine knows.
    const repo = resolvePath(given);
    if (!(await knownRepos()).some((known) => resolvePath(known) === repo)) return fail(c, 404, "unknown_repo", "the machine does not know that repository");
    const at = clock();
    try {
      const [current, signals, declined] = await Promise.all([pipeline.configChoices(repo), repoSignals.forRepo(repo, new Date(at.getTime() - SIGNAL_DAYS * DAY_MS)), pipeline.declinedConfigChanges(repo, at)]);
      const input = { current, candidates, signals, declined, now: at.toISOString() };
      const changes = proposeConfig(input);
      // A pack left out for mixed engines is named, so a person knows why it got no proposal.
      const skipped = proposalSkips(input);
      const extra = skipped.length > 0 ? { skipped } : {};
      if (changes.length === 0) return c.json({ changes, taskId: null, ...extra }, 200);
      const task = await serialize(await pipeline.proposeConfig(repo, changes));
      bus.publish({ type: "task.updated", task, seq: task.seq });
      return c.json({ changes, taskId: task.id, ...extra }, 200);
    } catch (error) {
      if (error instanceof PolicyParseError) return fail(c, 422, "invalid_config", error.message);
      throw error;
    }
  });

  // The setup skill's checks of a luna.yaml: `check` reads the text it is given (nothing runs, nothing is written); `prove` runs every check of the
  // file at the repository's root once in the sandbox, as a job read by id, and names the hosts the sandbox refused.
  app.openapi(checkConfigRoute, async (c) => {
    const { text } = c.req.valid("json");
    return c.json(checkLunaConfigText(text), 200);
  });

  app.openapi(proveConfigRoute, async (c) => {
    if (!configProofs) return fail(c, 503, "sandbox_off", "the machine has no sandbox to prove checks in (MACHINE_AGENTS=off or no Docker)");
    const { repoPath } = c.req.valid("json");
    return c.json(await configProofs.start(repoPath), 202);
  });

  app.openapi(proofJobRoute, (c) => {
    const job = configProofs?.get(c.req.param("id") ?? "") ?? null;
    if (!job) return fail(c, 404, "not_found", "no such proof (a restart forgets them; start it again)");
    return c.json(job, 200);
  });
  return app;
}
