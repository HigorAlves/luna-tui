// OpenAPI definitions of the on-demand design routes (RFC 0013, phase 2).
import { A11yAuditAnswer, A11yRunInput, type A11yReport, DesignContext, DesignSpec, type DesignSpecReport, DesignSpecRunInput, Finding } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Design"];

export const DesignSpecReportSchema = z.object({ kind: z.literal("spec"), ref: DesignContext, spec: DesignSpec }).openapi("DesignSpecReport");
expectSame<Same<z.infer<typeof DesignSpecReportSchema>, DesignSpecReport>>();

export const A11yReportSchema = z
  .object({
    kind: z.literal("audit"),
    target: z.string(),
    level: z.enum(["AA", "AAA"]),
    mode: z.enum(["gate", "advisory"]),
    findings: z.array(Finding),
    pages: A11yAuditAnswer.shape.pages,
    notes: z.array(z.string()),
  })
  .openapi("A11yReport");
expectSame<Same<z.infer<typeof A11yReportSchema>, A11yReport>>();

export const designSpecRoute = createRoute({
  method: "post",
  path: "/design/spec",
  tags: TAGS,
  summary: "Write a design spec from a Figma link",
  description:
    "Resolves the repository (an absolute path the machine knows) and the Figma reference in the link, then runs the `design_spec` pack under the same cap, spend and sandbox as `POST /ticket-chat`. The machine keeps nothing of the report.",
  request: jsonBody(DesignSpecRunInput),
  responses: {
    200: jsonContent(DesignSpecReportSchema, "The design spec and the reference it came from"),
    ...errorResponses(400, 404, 409, 422, 429, 499, 502, 503),
  },
});

export const designAuditRoute = createRoute({
  method: "post",
  path: "/design/audit",
  tags: TAGS,
  summary: "Audit a QA target's accessibility",
  description:
    "Runs the `a11y_audit` pack against one of the repository's declared QA targets, at the repository's WCAG level, and maps the findings to review findings. Needs the QA image. The machine keeps nothing of the report.",
  request: jsonBody(A11yRunInput),
  responses: {
    200: jsonContent(A11yReportSchema, "The audit's findings"),
    ...errorResponses(404, 409, 422, 429, 499, 502, 503),
  },
});
