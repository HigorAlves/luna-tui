// OpenAPI route definitions of the manager's compliance drafts and jobs (RFC 0008): each route's request and every
// response it can give, in zod. Every route answers 503 `compliance_off` when the machine has no compliance wiring.
import { ComplianceActInput, ComplianceDraft, type ComplianceDraft as ComplianceDraftType, ComplianceEditInput, ComplianceRepoInput } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import type { Incident } from "../../../domain/incident.ts";
import type { AssessedBreach, IncidentBreach } from "../../../domain/breach.ts";
import type { VulnRow } from "../../../application/vulns.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Compliance"];

/** `POST /compliance/release-notes`: the repo, the tag and, optionally, where the notes start. */
export const ReleaseNotesRunInput = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"),
  tag: z.string().regex(/^[A-Za-z0-9._\/-]+$/, "a tag"),
  since: z.string().datetime().optional(),
});
/** `POST /compliance/evidence/run`: the repo and the month. */
export const EvidenceRunInput = z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name"), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM") });
/** `POST /compliance/status/run`: an ISO week (the previous one when left out). */
export const StatusRunInput = z.object({ week: z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, "an ISO week like 2026-W46").optional() });
/** `POST /compliance/access/run`: the GitHub org. */
export const AccessRunInput = z.object({ org: z.string().regex(/^[A-Za-z0-9-]+$/, "a GitHub org") });

/** A draft the manager wrote and the person taps (the contracts' own schema). */
export const ComplianceDraftSchema = z.object(ComplianceDraft.shape).openapi("ComplianceDraft");
expectSame<Same<z.infer<typeof ComplianceDraftSchema>, ComplianceDraftType>>();

const severity = z.enum(["critical", "high", "medium", "low", "unknown"]);
const yesNo = z.object({ value: z.boolean(), p: z.number() });
const regime = z.enum(["gdpr", "lgpd", "hipaa", "us_privacy"]);

const IncidentSignalSchema = z
  .object({
    source: z.enum(["datadog", "sentry", "slack", "jira"]),
    id: z.string(),
    title: z.string(),
    severity,
    status: z.enum(["open", "resolved"]),
    startedAt: z.string(),
    updatedAt: z.string(),
    url: z.string().nullable(),
    service: z.string().nullable(),
    summary: z.string(),
  })
  .openapi("IncidentSignal");

const AssessedBreachSchema = z.object({
  assessedAt: z.string(),
  answers: z.object({
    personal_data: yesNo,
    phi: yesNo,
    eu_subjects: yesNo,
    br_subjects: yesNo,
    us_subjects: yesNo,
    us_elements: yesNo,
    subjects: z.object({ score: z.number(), confidence: z.number() }),
  }),
  regimes: z.array(regime),
  clocks: z.object({ gdpr: z.string().optional(), lgpd: z.string().optional(), hipaa: z.string().optional(), us_privacy: z.string().optional() }),
  error: z.string().optional(),
  errorAt: z.string().optional(),
});
expectSame<Same<z.infer<typeof AssessedBreachSchema>, AssessedBreach>>();

const IncidentBreachSchema = z.union([AssessedBreachSchema, z.object({ error: z.string(), errorAt: z.string().optional() })]).openapi("IncidentBreach");
expectSame<Same<z.infer<typeof IncidentBreachSchema>, IncidentBreach>>();

/** An incident the sources' signals folded into, with its breach assessment and clocks. */
export const IncidentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    severity,
    status: z.enum(["open", "resolved"]),
    startedAt: z.string(),
    seenAt: z.string().optional(),
    resolvedAt: z.string().nullable(),
    service: z.string().nullable(),
    signals: z.array(IncidentSignalSchema),
    timeline: z.array(z.object({ at: z.string(), source: z.string(), text: z.string() })),
    breach: IncidentBreachSchema.optional(),
    breachCardId: z.string().optional(),
    postmortem: z.object({ attempts: z.number().int(), lastAttemptAt: z.string(), opened: z.literal(true).optional() }).optional(),
  })
  .openapi("Incident");
expectSame<Same<z.infer<typeof IncidentSchema>, Incident>>();

/** One security alert a card stands for. */
export const VulnRowSchema = z
  .object({
    repo: z.string(),
    key: z.string().openapi({ example: "dependabot:12" }),
    severity: z.enum(["critical", "high", "medium", "low"]),
    lane: z.enum(["fast", "full", "hold"]),
    deadline: z.string(),
    cardId: z.string(),
    overdue: z.boolean(),
  })
  .openapi("VulnRow");
expectSame<Same<z.infer<typeof VulnRowSchema>, VulnRow>>();

const DraftIdParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "change_evidence:acme/web:2026-10", description: "The draft's id (it holds `:` and `/`: percent-encode it)" }),
});

export const incidentsRoute = createRoute({
  operationId: "listIncidents",
  method: "get",
  path: "/compliance/incidents",
  tags: TAGS,
  summary: "The incidents",
  description: "Every incident the sources' signals folded into (Sentry, Datadog, Jira, Slack), with its breach assessment and clocks. 503 `compliance_off` on a machine with no compliance drafts.",
  responses: { 200: jsonContent(z.object({ incidents: z.array(IncidentSchema) }), "The incidents"), ...errorResponses(503) },
});

export const draftsRoute = createRoute({
  operationId: "listComplianceDrafts",
  method: "get",
  path: "/compliance/drafts",
  tags: TAGS,
  summary: "The manager's drafts",
  description: "Every draft waiting for a tap, edited, ignored or posted. 503 `compliance_off` on a machine with no compliance drafts.",
  responses: { 200: jsonContent(z.object({ drafts: z.array(ComplianceDraftSchema) }), "The drafts"), ...errorResponses(503) },
});

export const approveDraftRoute = createRoute({
  operationId: "approveComplianceDraft",
  method: "post",
  path: "/compliance/drafts/{id}/approve",
  tags: TAGS,
  summary: "Approve a draft",
  description: "Posts the draft to its targets. The tap names the hash of the text shown: a draft that changed since never posts (409 `stale_draft`); one not waiting is 409 `draft_not_waiting`; a text that carries a secret is 422 `secret`; a questionnaire with no repository is 422 `needs_repository`. 503 `compliance_off` on a machine with no compliance drafts.",
  request: { params: DraftIdParams, ...jsonBody(ComplianceActInput) },
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft, posted"), ...errorResponses(400, 404, 409, 422, 503) },
});

export const editDraftRoute = createRoute({
  operationId: "editComplianceDraft",
  method: "post",
  path: "/compliance/drafts/{id}/edit",
  tags: TAGS,
  summary: "Edit a draft's text",
  description: "Replaces the text the person will approve; the tap names the hash of the text shown (409 `stale_draft` when it changed). 503 `compliance_off` on a machine with no compliance drafts.",
  request: { params: DraftIdParams, ...jsonBody(ComplianceEditInput) },
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft, edited"), ...errorResponses(400, 404, 409, 422, 503) },
});

export const ignoreDraftRoute = createRoute({
  operationId: "ignoreComplianceDraft",
  method: "post",
  path: "/compliance/drafts/{id}/ignore",
  tags: TAGS,
  summary: "Ignore a draft",
  description: "Keeps the draft and never posts it. 503 `compliance_off` on a machine with no compliance drafts.",
  request: { params: DraftIdParams, ...jsonBody(ComplianceActInput) },
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft, ignored"), ...errorResponses(400, 404, 409, 503) },
});

export const reposRoute = createRoute({
  operationId: "listComplianceRepos",
  method: "get",
  path: "/compliance/repos",
  tags: TAGS,
  summary: "The repositories the machine knows",
  description: "The `owner/name` of every repository a draft may name. 503 `compliance_off` on a machine with no compliance drafts.",
  responses: { 200: jsonContent(z.object({ repos: z.array(z.string()) }), "The repositories"), ...errorResponses(503) },
});

export const rerunDraftRoute = createRoute({
  operationId: "rerunComplianceDraft",
  method: "post",
  path: "/compliance/drafts/{id}/repo",
  tags: TAGS,
  summary: "Answer a questionnaire again from another repository",
  description: "Re-answers a questionnaire draft from another repository's wiki. 400 `unknown_repository` when the machine does not know it. 503 `compliance_off` when the machine has no compliance drafts or no questionnaires.",
  request: { params: DraftIdParams, ...jsonBody(ComplianceRepoInput) },
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft, answered again"), ...errorResponses(400, 404, 409, 422, 503) },
});

export const vulnsRoute = createRoute({
  operationId: "listVulnerabilities",
  method: "get",
  path: "/compliance/vulns",
  tags: TAGS,
  summary: "The security alerts the cards stand for",
  description: "Each alert's lane, deadline and whether it is overdue. 503 `compliance_off` when the machine has no compliance drafts or no vulnerability job.",
  responses: { 200: jsonContent(z.object({ alerts: z.array(VulnRowSchema) }), "The alerts"), ...errorResponses(503) },
});

export const releaseNotesRoute = createRoute({
  operationId: "draftReleaseNotes",
  method: "post",
  path: "/compliance/release-notes",
  tags: TAGS,
  summary: "Draft the release notes of a tag",
  description: "Drafts the notes from the PRs merged since the last release (or `since`); the person approves them onto the release. 400 `unknown_repository` when the machine does not know the repository. 503 `compliance_off` when the machine has no compliance drafts or no release notes.",
  request: jsonBody(ReleaseNotesRunInput),
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft"), ...errorResponses(400, 409, 422, 503) },
});

export const evidenceRunRoute = createRoute({
  operationId: "runChangeEvidence",
  method: "post",
  path: "/compliance/evidence/run",
  tags: TAGS,
  summary: "Rebuild a month's change evidence",
  description: "An on-demand rebuild of a month, for testing a past one: the same draft the monthly job opens. 400 `unknown_repository` when the machine does not know the repository. 503 `compliance_off` on a machine with no compliance drafts.",
  request: jsonBody(EvidenceRunInput),
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft"), ...errorResponses(400, 409, 422, 503) },
});

export const statusRunRoute = createRoute({
  operationId: "runStatusReport",
  method: "post",
  path: "/compliance/status/run",
  tags: TAGS,
  summary: "Build a week's status report",
  description: "An on-demand build of a week's status report (the previous week when none is named): the same draft the weekly job opens. 503 `compliance_off` when the machine has no compliance drafts or no status report.",
  request: jsonBody(StatusRunInput),
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft"), ...errorResponses(400, 409, 422, 503) },
});

export const accessRunRoute = createRoute({
  operationId: "runAccessReview",
  method: "post",
  path: "/compliance/access/run",
  tags: TAGS,
  summary: "Rebuild the quarter's access review",
  description: "An on-demand rebuild of the current quarter's access review: the same draft the quarterly job opens. 400 `unknown_org` when the machine has no compliance repository in that organization. 503 `compliance_off` when the machine has no compliance drafts or no access review.",
  request: jsonBody(AccessRunInput),
  responses: { 200: jsonContent(ComplianceDraftSchema, "The draft"), ...errorResponses(400, 409, 422, 503) },
});
