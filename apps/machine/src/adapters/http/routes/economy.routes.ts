// The token economy (RFC 0007).
import { EconomyRepoInput } from "@hardness/contracts";
import { isAbsolute } from "node:path";
import { createOpenApiRouter } from "../openapi/router.ts";
import { approveMaskRoute, dropFactRoute, economyStatusRoute, importRunsRoute, restoreMaskRoute } from "./economy.openapi.ts";
import { BadRequest, type RouteDeps } from "./kit.ts";

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
    app.openapi(economyStatusRoute, async (c) => {
      const repo = await known(EconomyRepoInput.parse({ repo: c.req.query("repo") }).repo);
      return c.json(await economy.port.status(repo, (await economy.configOf(repo)).guard.envelope_min_samples), 200);
    });
    app.openapi(dropFactRoute, async (c) => {
      const { repo } = c.req.valid("json");
      return c.json({ dropped: await economy.port.dropFact(await known(repo), c.req.param("id")) }, 200);
    });
    app.openapi(approveMaskRoute, async (c) => {
      const { repo, pack } = c.req.valid("json");
      return c.json({ approved: await economy.port.approveMask(await known(repo), pack) }, 200);
    });
    app.openapi(restoreMaskRoute, async (c) => {
      const { repo, pack, unit } = c.req.valid("json");
      return c.json({ restored: await economy.port.restore(await known(repo), pack, unit) }, 200);
    });
    // The runs already on disk are folded once; a second call finds none.
    app.openapi(importRunsRoute, async (c) => {
      const { repo } = c.req.valid("json");
      await known(repo);
      return c.json({ runs: await economy.port.importRuns(repo, await economy.configOf(repo)) }, 200);
    });
  }
  return app;
}
