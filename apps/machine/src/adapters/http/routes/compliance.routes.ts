// The manager's compliance drafts and jobs (RFC 0008).
import type { Context } from "hono";
import { isoWeek } from "../../../domain/status-report.ts";
import { tapOf } from "../../../application/slack-send.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { accessRunRoute, approveDraftRoute, draftsRoute, editDraftRoute, evidenceRunRoute, ignoreDraftRoute, incidentsRoute, releaseNotesRoute, reposRoute, rerunDraftRoute, statusRunRoute, vulnsRoute } from "./compliance.openapi.ts";
import { fail, type RouteDeps } from "./kit.ts";

export function complianceRoutes(deps: RouteDeps) {
  const { compliance } = deps;
  const app = createOpenApiRouter();
  {
    // The manager's drafts: the board's Compliance view lists them and taps them. The id holds `:` and `/`, which the board percent-encodes; Hono decodes the segment.
    const off = (c: Context) => fail(c, 503, "compliance_off", "this machine has no compliance drafts");
    app.openapi(incidentsRoute, async (c) => (compliance ? c.json({ incidents: await compliance.incidents.list() }, 200) : off(c)));
    app.openapi(draftsRoute, async (c) => (compliance ? c.json({ drafts: await compliance.drafts.list() }, 200) : off(c)));
    app.openapi(approveDraftRoute, async (c) => (compliance ? c.json(await compliance.publisher.approve(c.req.valid("param").id, c.req.valid("json").hash, "board", tapOf("POST /compliance/drafts/:id/approve")), 200) : off(c)));
    app.openapi(editDraftRoute, async (c) => {
      if (!compliance) return off(c);
      const { hash, text } = c.req.valid("json");
      return c.json(await compliance.drafts.edit(c.req.valid("param").id, hash, text, "board"), 200);
    });
    app.openapi(ignoreDraftRoute, async (c) => (compliance ? c.json(await compliance.drafts.ignore(c.req.valid("param").id, c.req.valid("json").hash, "board"), 200) : off(c)));
    app.openapi(reposRoute, async (c) => (compliance ? c.json({ repos: await compliance.repos() }, 200) : off(c)));
    // A questionnaire answered again from another repository's wiki.
    app.openapi(rerunDraftRoute, async (c) => {
      if (!compliance?.questionnaires) return off(c);
      const { repo } = c.req.valid("json");
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.questionnaires.rerun(c.req.valid("param").id, repo), 200);
    });
    // The security alerts a card stands for, with each one's lane, deadline and whether it is overdue.
    app.openapi(vulnsRoute, async (c) => (compliance?.vulns ? c.json({ alerts: await compliance.vulns.list() }, 200) : off(c)));
    // Release notes for a tag, drafted from the PRs merged since the last release (or `since`); the person approves them onto the release.
    app.openapi(releaseNotesRoute, async (c) => {
      if (!compliance?.releaseNotes) return off(c);
      const { repo, tag, since } = c.req.valid("json");
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.releaseNotes.draft({ repo, tag, ...(since ? { since } : {}) }), 200);
    });
    // An on-demand rebuild of a month, for testing a past one: the same draft the monthly job opens.
    app.openapi(evidenceRunRoute, async (c) => {
      if (!compliance) return off(c);
      const { repo, period } = c.req.valid("json");
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.evidence.buildMonth(repo, period), 200);
    });
    // An on-demand build of a week's status report (the previous week when none is named): the same draft the weekly job opens.
    app.openapi(statusRunRoute, async (c) => {
      if (!compliance?.status) return off(c);
      const { week } = c.req.valid("json");
      return c.json(await compliance.status.build(week ?? isoWeek(new Date(Date.now() - 7 * 86_400_000))), 200);
    });
    // An on-demand rebuild of the current quarter's access review: the same draft the quarterly job opens.
    app.openapi(accessRunRoute, async (c) => {
      if (!compliance?.access) return off(c);
      const { org } = c.req.valid("json");
      if (!(await compliance.access.orgs()).includes(org)) return fail(c, 400, "unknown_org", "the machine has no compliance repository in that organization");
      return c.json(await compliance.access.buildQuarter(org), 200);
    });
  }
  return app;
}
