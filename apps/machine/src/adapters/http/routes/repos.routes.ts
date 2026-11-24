// Repositories: health, base approval, setup, config proposals and the luna.yaml checks.
import { ProposalsInput, SetupRepoInput, ConfigCheckInput } from "@hardness/contracts";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { checkLunaConfigText } from "../../../domain/luna-config.ts";
import { proposalSkips, proposeConfig } from "../../../domain/config-proposal.ts";
import { PolicyParseError } from "../../../domain/policy.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { BadRequest, SIGNAL_DAYS, DAY_MS, fail, body, taskId, type RouteDeps } from "./kit.ts";

export function reposRoutes(deps: RouteDeps) {
  const { repoHealth, approveBase, pipeline, bus, runs, configProofs, repoSignals, knownRepos, clock, serialize } = deps;
  const app = createOpenApiRouter();
  app.get("/repos", async (c) => c.json((await repoHealth?.()) ?? []));

  if (approveBase) {
    // A base runs the stage's process and can read its credential: a person approves the exact reference, here, and only for the base the repository names now.
    app.post("/repos/base/approve", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { repo?: unknown; base?: unknown } | null;
      if (typeof body?.repo !== "string" || typeof body.base !== "string" || !body.repo || !body.base) throw new BadRequest("repo and base are required");
      const result = await approveBase(body.repo, body.base);
      if (!result.ok) throw new BadRequest(result.reason);
      return c.json({ repo: body.repo, base: body.base, approved: true });
    });
  }

  app.post("/repos/setup", async (c) => {
    const { repoPath } = await body(c, SetupRepoInput);
    return c.json(await serialize(await pipeline.setupRepo(repoPath)), 201);
  });

  // A config proposal: the scorecards come in the body, the repo's luna.yaml and its own run signals are read here, a fixed rule picks the
  // changes (domain/config-proposal.ts), and a non-empty result waits at the setup gate as a `config` card.
  app.post("/repos/proposals", async (c) => {
    const { repo: given, candidates } = await body(c, ProposalsInput);
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
      if (changes.length === 0) return c.json({ changes, taskId: null, ...extra });
      const task = await serialize(await pipeline.proposeConfig(repo, changes));
      bus.publish({ type: "task.updated", task, seq: task.seq });
      return c.json({ changes, taskId: task.id, ...extra });
    } catch (error) {
      if (error instanceof PolicyParseError) return fail(c, 422, "invalid_config", error.message);
      throw error;
    }
  });

  // The setup skill's checks of a luna.yaml: `check` reads the text it is given (nothing runs, nothing is written); `prove` runs every check of the
  // file at the repository's root once in the sandbox, as a job read by id, and names the hosts the sandbox refused.
  app.post("/repos/config/check", async (c) => {
    const { text } = await body(c, ConfigCheckInput);
    return c.json(checkLunaConfigText(text));
  });

  app.post("/repos/config/prove", async (c) => {
    if (!configProofs) return fail(c, 503, "sandbox_off", "the machine has no sandbox to prove checks in (MACHINE_AGENTS=off or no Docker)");
    const { repoPath } = await body(c, SetupRepoInput);
    return c.json(await configProofs.start(repoPath), 202);
  });

  app.get("/repos/config/prove/:id", (c) => {
    const job = configProofs?.get(c.req.param("id") ?? "") ?? null;
    if (!job) return fail(c, 404, "not_found", "no such proof (a restart forgets them; start it again)");
    return c.json(job);
  });
  return app;
}
