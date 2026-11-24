// Who may call the API. The machine's clients are the board, the notch and scripts: none of them
// is a web page, so none sends an `Origin`, and every one declares the JSON it sends. A browser
// page can still reach 127.0.0.1, so every request passes four checks, in this order:
// - Host: while the machine binds to loopback, the `Host` header must name it (127.0.0.1,
//   localhost or [::1] on its port), so a rebound DNS name gets 403 `forbidden_host`.
// - Origin: one is only sent by a browser; any but the machine's own is 403 `forbidden_origin`.
// - Token: with `MACHINE_API_TOKEN`, `Authorization: Bearer <token>` or 401 `unauthorized`. The API's own
//   description (`GET /openapi.json`, `GET /docs`) is read without it: it holds no data, and a browser opening
//   the docs cannot send a header. A call made from the docs page still carries the token (Swagger's Authorize).
// - Body: bytes that are not `application/json` are 415 `unsupported_media_type`. A page can
//   only send JSON across sites after a CORS preflight, which the machine never allows.
import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

export interface ApiAccess {
  /** The interface the machine binds to. */
  host: string;
  port: number;
  /** The bearer token every request must carry; null asks for none. */
  token: string | null;
  /** The port the host publishes the machine on when it differs from `port` (Docker maps 4318 to 4317), so the docs page opened there may call the API. */
  publicPort?: number | null;
}

/** The API's own description, read without the token. */
export const DOCS_PATHS: ReadonlySet<string> = new Set(["/openapi.json", "/docs"]);

/** Whether a bind address only listens on this computer. */
export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

const JSON_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?[\w-]+"?\s*)?$/i;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares in constant time, whatever the lengths. */
function sameToken(given: string, token: string): boolean {
  return timingSafeEqual(digest(given), digest(token));
}

export function guard(access: ApiAccess): MiddlewareHandler {
  const names = ["127.0.0.1", "localhost", "[::1]"];
  if (isLoopback(access.host) && !names.includes(access.host)) names.push(access.host.includes(":") ? `[${access.host}]` : access.host);
  const hosts = new Set(names.map((name) => `${name}:${access.port}`));
  const ports = access.publicPort && access.publicPort !== access.port ? [access.port, access.publicPort] : [access.port];
  const origins = new Set(names.flatMap((name) => ports.map((port) => `http://${name}:${port}`)));
  const checkHost = isLoopback(access.host);
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (checkHost && host !== undefined && !hosts.has(host)) {
      return c.json({ error: "forbidden_host", message: `the machine answers on ${[...hosts].join(", ")}, not ${host}` }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return c.json({ error: "forbidden_origin", message: "the machine does not take requests from web pages" }, 403);
    }
    if (access.token !== null && !(DOCS_PATHS.has(c.req.path) && c.req.method === "GET")) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
      if (!match || !sameToken(match[1]!, access.token)) {
        c.header("WWW-Authenticate", "Bearer");
        return c.json({ error: "unauthorized", message: "this machine needs its API token: Authorization: Bearer <MACHINE_API_TOKEN>" }, 401);
      }
    }
    const type = c.req.header("content-type");
    const length = c.req.header("content-length");
    const carries = (length !== undefined && length.trim() !== "0") || c.req.header("transfer-encoding") !== undefined || (type !== undefined && length === undefined);
    if (carries && (type === undefined || !JSON_TYPE.test(type.trim()))) {
      return c.json({ error: "unsupported_media_type", message: `a request body must be Content-Type: application/json, got ${type ?? "none"}` }, 415);
    }
    await next();
  };
}
