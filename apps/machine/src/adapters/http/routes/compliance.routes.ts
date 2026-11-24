// The manager's compliance drafts and jobs (RFC 0008).
import { ComplianceActInput, ComplianceEditInput, ComplianceRepoInput } from "@hardness/contracts";
import { type Context, Hono } from "hono";
import { isoWeek } from "../../../domain/status-report.ts";
import { tapOf } from "../../../application/slack-send.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { ReleaseNotesRunInput, EvidenceRunInput, StatusRunInput, AccessRunInput, fail, body, type RouteDeps } from "./kit.ts";

export function complianceRoutes(deps: RouteDeps) {
  const { compliance } = deps;
  const app = createOpenApiRouter();
  {
    // The manager's drafts: the board's Compliance view lists them and taps them. The id holds `:` and `/`, which the board percent-encodes; Hono decodes the segment.
    const off = (c: Context) => fail(c, 503, "compliance_off", "this machine has no compliance drafts");
    const id = (c: Context): string => c.req.param("id") ?? "";
    app.get("/compliance/incidents", async (c) => (compliance ? c.json({ incidents: await compliance.incidents.list() }) : off(c)));
    app.get("/compliance/drafts", async (c) => (compliance ? c.json({ drafts: await compliance.drafts.list() }) : off(c)));
    app.post("/compliance/drafts/:id/approve", async (c) => (compliance ? c.json(await compliance.publisher.approve(id(c), (await body(c, ComplianceActInput)).hash, "board", tapOf("POST /compliance/drafts/:id/approve"))) : off(c)));
    app.post("/compliance/drafts/:id/edit", async (c) => {
      if (!compliance) return off(c);
      const { hash, text } = await body(c, ComplianceEditInput);
      return c.json(await compliance.drafts.edit(id(c), hash, text, "board"));
    });
    app.post("/compliance/drafts/:id/ignore", async (c) => (compliance ? c.json(await compliance.drafts.ignore(id(c), (await body(c, ComplianceActInput)).hash, "board")) : off(c)));
    app.get("/compliance/repos", async (c) => (compliance ? c.json({ repos: await compliance.repos() }) : off(c)));
    // A questionnaire answered again from another repository's wiki.
    app.post("/compliance/drafts/:id/repo", async (c) => {
      if (!compliance?.questionnaires) return off(c);
      const { repo } = await body(c, ComplianceRepoInput);
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.questionnaires.rerun(id(c), repo));
    });
    // The security alerts a card stands for, with each one's lane, deadline and whether it is overdue.
    app.get("/compliance/vulns", async (c) => (compliance?.vulns ? c.json({ alerts: await compliance.vulns.list() }) : off(c)));
    // Release notes for a tag, drafted from the PRs merged since the last release (or `since`); the person approves them onto the release.
    app.post("/compliance/release-notes", async (c) => {
      if (!compliance?.releaseNotes) return off(c);
      const { repo, tag, since } = await body(c, ReleaseNotesRunInput);
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.releaseNotes.draft({ repo, tag, ...(since ? { since } : {}) }));
    });
    // An on-demand rebuild of a month, for testing a past one: the same draft the monthly job opens.
    app.post("/compliance/evidence/run", async (c) => {
      if (!compliance) return off(c);
      const { repo, period } = await body(c, EvidenceRunInput);
      if (!(await compliance.repos()).includes(repo)) return fail(c, 400, "unknown_repository", "the machine does not know that repository");
      return c.json(await compliance.evidence.buildMonth(repo, period));
    });
    // An on-demand build of a week's status report (the previous week when none is named): the same draft the weekly job opens.
    app.post("/compliance/status/run", async (c) => {
      if (!compliance?.status) return off(c);
      const { week } = await body(c, StatusRunInput);
      return c.json(await compliance.status.build(week ?? isoWeek(new Date(Date.now() - 7 * 86_400_000))));
    });
    // An on-demand rebuild of the current quarter's access review: the same draft the quarterly job opens.
    app.post("/compliance/access/run", async (c) => {
      if (!compliance?.access) return off(c);
      const { org } = await body(c, AccessRunInput);
      if (!(await compliance.access.orgs()).includes(org)) return fail(c, 400, "unknown_org", "the machine has no compliance repository in that organization");
      return c.json(await compliance.access.buildQuarter(org));
    });
  }
  return app;
}
