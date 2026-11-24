// The router every route module is built on (the same factory as workbench's `createOpenApiRouter`).
// `OpenAPIHono` with no `defaultHook` answers a request that fails its schema with its own
// `{ success: false, error }` 400, bypassing `app.onError`. This hook throws the ZodError instead, so
// a bad body, query or param gets the machine's one error shape: 400 `invalid_request` (app.ts).
import { type Hook, OpenAPIHono } from "@hono/zod-openapi";

// biome-ignore lint/suspicious/noExplicitAny: the hook is the same for every route's schemas
const throwOnInvalid: Hook<any, any, any, any> = (result) => {
  if (!result.success) throw result.error;
};

export function createOpenApiRouter() {
  return new OpenAPIHono({ defaultHook: throwOnInvalid });
}
