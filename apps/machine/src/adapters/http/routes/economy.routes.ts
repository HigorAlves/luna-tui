// The token economy (RFC 0007).
import { EconomyApproveInput, EconomyRepoInput, EconomyRestoreInput } from "@hardness/contracts";
import { isAbsolute } from "node:path";
import { createOpenApiRouter } from "../openapi/router.ts";
import { BadRequest, body, type RouteDeps } from "./kit.ts";

export function economyRoutes(deps: RouteDeps) {
  const { economy, runs } = deps;
  const app = createOpenApiRouter();
  if (economy) {
    /** A checkout the machine knows, named by its absolute path: anything else is a 400. */
    const known = async (repo: string): Promise<string> => {
      if (!isAbsolute(repo)) throw new BadRequest("repo must be an absolute path");
      if (!(await economy.knownRepos()).includes(repo)) throw new BadRequest("the machine does not know that repository");
      return repo;
    };
    app.get("/economy", async (c) => {
      const repo = await known(EconomyRepoInput.parse({ repo: c.req.query("repo") }).repo);
      return c.json(await economy.port.status(repo, (await economy.configOf(repo)).guard.envelope_min_samples));
    });
    app.post("/economy/facts/:id/drop", async (c) => {
      const { repo } = await body(c, EconomyRepoInput);
      return c.json({ dropped: await economy.port.dropFact(await known(repo), c.req.param("id")) });
    });
    app.post("/economy/mask/approve", async (c) => {
      const { repo, pack } = await body(c, EconomyApproveInput);
      return c.json({ approved: await economy.port.approveMask(await known(repo), pack) });
    });
    app.post("/economy/mask/restore", async (c) => {
      const { repo, pack, unit } = await body(c, EconomyRestoreInput);
      return c.json({ restored: await economy.port.restore(await known(repo), pack, unit) });
    });
    // The runs already on disk are folded once; a second call finds none.
    app.post("/economy/import", async (c) => {
      const { repo } = await body(c, EconomyRepoInput);
      await known(repo);
      return c.json({ runs: await economy.port.importRuns(repo, await economy.configOf(repo)) });
    });
  }
  return app;
}
