// Holds every answer the API gives to what `GET /openapi.json` says about it: the status must be one the
// route documents, and a JSON body must parse with that status's schema. The type checker already holds a
// handler's own `c.json(...)` to its route; this also catches what it cannot see: the statuses `app.onError`
// maps from thrown errors, and bodies that only go wrong at runtime. On in the machine's tests
// (`MACHINE_OPENAPI_CONFORMANCE=1`, see test/openapi-conformance.ts), off in production.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { type ZodType, z } from "zod";

import { DOCS_PATHS } from "../access.ts";

export interface Violation {
  route: string;
  status: number;
  problem: string;
}

/** What the machine's tests collected (test/openapi-conformance.ts reads and clears it). */
export const violations: Violation[] = [];

/** On when `MACHINE_OPENAPI_CONFORMANCE=1` (the machine's vitest setup sets it). */
export const conformanceOn = (): boolean => process.env.MACHINE_OPENAPI_CONFORMANCE === "1";

interface DocumentedResponse {
  content?: Record<string, { schema?: unknown }>;
}

/** The first violation of each kind is enough to act on; a body that fails is reported with zod's own words, cut short. */
const brief = (text: string): string => (text.length > 600 ? `${text.slice(0, 600)}…` : text);

export function responseConformance(app: OpenAPIHono, report: (violation: Violation) => void): MiddlewareHandler {
  let index: Map<string, Record<string, DocumentedResponse>> | null = null;
  const routes = () => {
    if (index) return index;
    index = new Map();
    for (const definition of app.openAPIRegistry.definitions) {
      if (definition.type === "route") index.set(`${definition.route.method.toUpperCase()} ${definition.route.path}`, definition.route.responses as Record<string, DocumentedResponse>);
    }
    return index;
  };
  return async (c, next) => {
    await next();
    const handler = matchedRoutes(c).filter((route) => route.method !== "ALL").at(-1);
    if (!handler || DOCS_PATHS.has(handler.path)) return;
    const route = `${handler.method} ${handler.path.replace(/:(\w+)/g, "{$1}")}`;
    const responses = routes().get(route);
    const status = c.res.status;
    if (!responses) return report({ route, status, problem: "the route is not in the document" });
    const documented = responses[String(status)];
    if (!documented) return report({ route, status, problem: `status ${status} is not documented (documented: ${Object.keys(responses).join(", ")})` });
    if (!documented.content) return;
    const type = (c.res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const content = documented.content[type];
    if (!content) return report({ route, status, problem: `content type "${type}" is not documented (documented: ${Object.keys(documented.content).join(", ")})` });
    if (type !== "application/json" || !content.schema) return;
    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      return report({ route, status, problem: "the body is not JSON" });
    }
    const parsed = (content.schema as ZodType).safeParse(body);
    if (!parsed.success) report({ route, status, problem: brief(z.prettifyError(parsed.error)) });
  };
}
