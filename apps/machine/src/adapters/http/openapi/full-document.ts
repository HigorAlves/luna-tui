// The whole API's OpenAPI document, every optional area switched on, built with no database or network:
// what `pnpm --filter @hardness/machine openapi` writes to apps/machine/openapi.json for frontends to
// generate clients from. A running machine's `GET /openapi.json` describes only the areas it has on.
import { Pipeline } from "../../../application/pipeline.ts";
import { StubStages } from "../../../application/stages/stubs.ts";
import { DEFAULT_POLICY } from "../../../domain/policy.ts";
import { createApp } from "../app.ts";
import { Bus } from "../bus.ts";

/** Where a local machine answers (`pnpm start`); a client points its generated code at its own. */
const SERVER = "127.0.0.1:4318";

export async function fullOpenApiDocument(): Promise<Record<string, unknown>> {
  // The routes are only read, never called: no dependency below is ever used.
  const unused = {} as never;
  const pipeline = new Pipeline(unused, new StubStages().runnerFor, { inline: true, policies: { for: async () => DEFAULT_POLICY }, hasConfig: () => true });
  const app = createApp({
    db: unused, pipeline, bus: new Bus(),
    // As compose runs it: bound beyond loopback, published on 4318.
    access: { host: "0.0.0.0", port: 4317, publicPort: 4318, token: null },
    repoHealth: async () => [], approveBase: async () => ({ ok: true }), economy: unused, backlog: unused, tickets: unused, compliance: unused,
    stubs: new StubStages(), pulls: unused, prTasks: unused, taskDiff: unused, slack: unused, jira: unused, mcp: unused, runs: unused, configProofs: unused,
  });
  const response = await app.request("/openapi.json", { headers: { host: SERVER } });
  if (response.status !== 200) throw new Error(`GET /openapi.json answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}
