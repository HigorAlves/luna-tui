// What every route's description shares (workbench's `openapi/schemas.ts`): the error body, the error
// responses by status, a JSON request body, a JSON response, the task id parameter, and `Same`, the
// compile-time check that a response schema says exactly what its contracts type says.
import type { ApiError } from "@hardness/contracts";
import { z } from "@hono/zod-openapi";

/** True only when A and B are the same type (each assignable to the other); a response schema asserts `Same<z.infer<typeof X>, X>`. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails to compile unless its argument is `true`: `expectSame<Same<A, B>>()`. */
export const expectSame = <T extends true>(): T => true as T;

/** Every error the machine answers: a stable `error` code, a sentence for a person, and sometimes more fields (`taskId`, `gaps`, `resetsAt`…). */
export const ApiErrorSchema = z
  .object({
    error: z.string().openapi({ example: "invalid_request" }),
    message: z.string().openapi({ example: "title: Too small: expected string to have >=1 characters" }),
  })
  .catchall(z.unknown())
  .openapi("ApiError");
expectSame<Same<Pick<z.infer<typeof ApiErrorSchema>, "error" | "message">, Pick<ApiError, "error" | "message">>>();

const ERROR_DESCRIPTIONS = {
  400: "The request is not valid (`invalid_request` and the route's own codes)",
  401: "The token is missing or wrong (`unauthorized`)",
  403: "A foreign `Host` or `Origin` (`forbidden_host`, `forbidden_origin`)",
  404: "Nothing by that id (`not_found` and the route's own codes)",
  409: "The card or item is not in a state that allows this",
  415: "A body that is not `application/json` (`unsupported_media_type`)",
  422: "Understood, but refused (a secret in a draft, an invalid config, a failed run)",
  429: "Too many runs: the queue is full, a budget is spent, the engine is rate limited, or GitHub is (`github_rate_limited`)",
  499: "The client closed the request before the run ended (`client_closed`)",
  500: "The machine failed (`internal`)",
  502: "The model gave no valid answer, or GitHub refused (`github_failed`, `github_unauthorized`, in GitHub's words)",
  503: "The feature is off on this machine (no agents, no sandbox, no compliance…)",
} as const;
export type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

const errorResponse = (status: ErrorStatus) => ({ content: { "application/json": { schema: ApiErrorSchema } }, description: ERROR_DESCRIPTIONS[status] });

/** The errors any route can answer: the door's (401, 403, 415) and the machine's own failure (500). */
export const CommonErrorResponses = { 401: errorResponse(401), 403: errorResponse(403), 415: errorResponse(415), 500: errorResponse(500) } as const;

/** The common errors plus the route's own statuses: `...errorResponses(400, 404, 409)`. */
export function errorResponses<const S extends ErrorStatus[]>(...statuses: S) {
  return { ...CommonErrorResponses, ...Object.fromEntries(statuses.map((status) => [status, errorResponse(status)])) } as typeof CommonErrorResponses & { [K in S[number]]: ReturnType<typeof errorResponse> };
}

/** A required JSON request body: a missing or malformed one is 400 `invalid_request`, as before. */
export const jsonBody = <T extends z.ZodType>(schema: T, description?: string) => ({
  body: { required: true, content: { "application/json": { schema } }, ...(description ? { description } : {}) },
});

/** A JSON response. */
export const jsonContent = <T extends z.ZodType>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });

/** `:id` of a task. Any string reaches the handler: an id that is not a UUID cannot exist, so it is a 404 (`taskId()`), not a 400. */
export const TaskIdParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "b933eac0-7593-4564-ac9b-906df1577792", description: "The task's id (a UUID)" }),
});
