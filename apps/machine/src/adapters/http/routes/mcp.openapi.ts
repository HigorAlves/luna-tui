// OpenAPI definitions of the MCP routes (RFC 0013): status, login, and the OAuth callback a browser lands on.
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, jsonContent } from "../openapi/schemas.ts";

const TAGS = ["MCP"];

const ServerParams = z.object({ server: z.string().openapi({ param: { name: "server", in: "path" }, example: "figma", description: "The MCP server's name" }) });

export const McpServerStatusSchema = z
  .object({
    name: z.string(),
    transport: z.enum(["http", "stdio"]),
    loggedIn: z.boolean(),
    loginPending: z.boolean().openapi({ description: "A login's state is outstanding and its callback has not settled" }),
    loginFailed: z.boolean().openapi({ description: "The last login's callback failed, or nobody finished it" }),
    tools: z.array(z.string()).openapi({ description: "The tools the server lists; empty when not logged in or not reachable" }),
    reachable: z.boolean(),
  })
  .openapi("McpServerStatus");

export const mcpStatusRoute = createRoute({
  method: "get",
  path: "/mcp",
  tags: TAGS,
  summary: "The MCP servers the machine bridges",
  description: "Each server, whether it is logged in, whether a login is pending or the last one failed, and the tools it lists. No token value ever reaches a response.",
  responses: { 200: jsonContent(z.array(McpServerStatusSchema), "The servers"), ...errorResponses() },
});

export const mcpLoginRoute = createRoute({
  method: "post",
  path: "/mcp/{server}/login",
  tags: TAGS,
  summary: "Start an OAuth login",
  description: "Hands back the URL to open in a browser (null when the server is already authorized). A new login replaces the server's earlier one.",
  request: { params: ServerParams },
  responses: {
    200: jsonContent(z.object({ authorizeUrl: z.string().nullable() }), "The authorize URL, or null when nothing more is needed"),
    ...errorResponses(404, 409),
  },
});

const html = (description: string) => ({ description, content: { "text/html": { schema: z.string() } } });

export const mcpCallbackRoute = createRoute({
  method: "get",
  path: "/mcp/{server}/callback",
  tags: TAGS,
  summary: "The OAuth callback",
  description:
    "Where the browser lands after authorizing. The one route with no bearer token (a redirect cannot carry one): it finishes only a login this machine started, by the `state` it issued, once, within ten minutes. Answers an HTML page.",
  security: [],
  request: {
    params: ServerParams,
    query: z.object({ state: z.string().optional(), code: z.string().optional() }),
  },
  responses: {
    200: html("Logged in; the tab can be closed"),
    400: html("The login was not started by this machine (unknown server, state, or code; or the state was used)"),
    502: html("The login failed"),
  },
});
