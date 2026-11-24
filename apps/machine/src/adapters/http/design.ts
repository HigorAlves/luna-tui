// The on-demand design routes (RFC 0013, phase 2): `POST /design/spec` and `POST /design/audit`. Each resolves the repository, the Figma link or the QA
// target on the machine, then runs the pack through PackRuns as `POST /ticket-chat` does: the same cap, spend, `pack_runs` row and untrusted sandbox.
// A client sends a repo and a link or a target name, never a URL or a credential. The machine keeps nothing of the report (the board holds it).
import { A11yAuditAnswer, type A11yReport, DesignSpec, type DesignSpecReport, designSettings } from "@hardness/contracts";
import { isAbsolute } from "node:path";
import type { Context } from "hono";
import { ZodError } from "zod";

import { RunCredentialBusyError, RunFailedError, type PackRunsPort } from "../../application/pack-runs.ts";
import type { PolicyStore } from "../../application/policy.ts";
import { a11yFindings } from "../../domain/a11y-findings.ts";
import { designRefOf, figmaRefsIn } from "../../domain/design-ref.ts";
import { createOpenApiRouter } from "./openapi/router.ts";
import { realOrNull, fail } from "./routes/kit.ts";
import { designAuditRoute, designSpecRoute } from "./routes/design.openapi.ts";

type Ctx = Context;

export interface DesignRoutes {
  runs?: PackRunsPort;
  /** The repos the routes may read: the same list as `POST /ticket-chat`. */
  chatRepos: () => Promise<string[]>;
  policies?: Pick<PolicyStore, "for">;
  /** Whether the QA image is built; the audit needs it. */
  qaImage: boolean;
}

export function designRoutes(deps: DesignRoutes) {
  const app = createOpenApiRouter();
  /** The repo as a real path, one of the machine's known ones; else null. */
  const known = async (given: string): Promise<string | null> => {
    if (!isAbsolute(given)) return null;
    const repo = await realOrNull(given);
    if (repo === null) return null;
    return (await Promise.all((await deps.chatRepos()).map(realOrNull))).includes(repo) ? repo : null;
  };
  const unknownRepo = (c: Ctx) => fail(c, 404, "unknown_repo", "the machine does not know that repository");
  const agentsOff = (c: Ctx) => fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
  const failed = (c: Ctx, error: unknown, code: string, what: string) => {
    if (error instanceof RunCredentialBusyError) return fail(c, 409, "engine_busy", "that engine's login is busy with another run: try the other engine, or again in a minute");
    if (error instanceof RunFailedError) return fail(c, 502, code, error.message);
    if (error instanceof ZodError) return fail(c, 502, code, `${what} gave no valid answer`);
    throw error;
  };

  app.openapi(designSpecRoute, async (c) => {
    const { repo: given, link, engine } = c.req.valid("json");
    const repo = await known(given);
    if (repo === null) return unknownRepo(c);
    if (figmaRefsIn(link, "link").length === 0) return fail(c, 400, "no_design_reference", "the link has no Figma file reference");
    const settings = designSettings((await deps.policies?.for(repo))?.design);
    if (settings.off) return fail(c, 409, "design_off", "design is turned off for this repository (luna.yaml design: off)");
    const ref = designRefOf({ link, text: "", attachments: [], settings });
    if (!ref) return fail(c, 400, "no_design_reference", "the link has no Figma file reference");
    if (!deps.runs) return agentsOff(c);
    try {
      const result = await deps.runs.run({ pack: "design_spec", ...(engine ? { engine } : {}), context: { design: ref } }, "board", c.req.raw.signal, { readRepo: repo, bridge: { repoPath: repo } });
      const report: DesignSpecReport = { kind: "spec", ref, spec: DesignSpec.parse(result.answer) };
      return c.json(report, 200);
    } catch (error) {
      return failed(c, error, "design_failed", "the design spec writer");
    }
  });

  app.openapi(designAuditRoute, async (c) => {
    const { repo: given, target: name, engine } = c.req.valid("json");
    const repo = await known(given);
    if (repo === null) return unknownRepo(c);
    const policy = await deps.policies?.for(repo);
    const settings = designSettings(policy?.design);
    if (settings.off) return fail(c, 409, "design_off", "design is turned off for this repository (luna.yaml design: off)");
    const target = (policy?.qaTargets ?? []).find((t) => t.name === name);
    if (!target) return fail(c, 404, "unknown_target", `the repository declares no QA target named ${name}`);
    if (!deps.qaImage) return fail(c, 503, "qa_image_missing", "the QA image is not built on this machine (pnpm runner-qa:build)");
    if (!deps.runs) return agentsOff(c);
    try {
      const result = await deps.runs.run({ pack: "a11y_audit", ...(engine ? { engine } : {}), context: { a11y: { level: settings.a11y.level } } }, "board", c.req.raw.signal, { readRepo: repo, qa: { repoPath: repo, target } });
      const answer = A11yAuditAnswer.parse(result.answer);
      const mapped = a11yFindings(answer.findings, settings.a11y);
      const report: A11yReport = { kind: "audit", target: target.name, level: settings.a11y.level, mode: settings.a11y.mode, findings: mapped.findings, pages: answer.pages, notes: mapped.notes };
      return c.json(report, 200);
    } catch (error) {
      return failed(c, error, "design_failed", "the accessibility auditor");
    }
  });
  return app;
}
