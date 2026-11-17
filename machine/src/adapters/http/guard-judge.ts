// The listener the stage guards call for the judge (RFC 0012, B6): `POST /v1/chat/completions` and nothing else, in SafeAgents' request and
// an OpenAI chat completion's reply. It is not the machine's API (app.ts, loopback): a guard container reaches it through the egress proxy's
// allow-private entry `host.docker.internal:<port>`, so it binds beyond loopback and trusts only the per-run bearer key the judge registered.
// Not a public route: no client calls it, so docs/api.md does not list it.
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { GuardJudge } from "../../application/guard-judge.ts";

/** A request body is SafeAgents' prompt (at most ~6000 characters of task and 4000 of arguments, JSON-escaped): anything past this is not one. */
const BODY_MAX = 256 * 1024;
const PATH = "/v1/chat/completions";

export interface GuardJudgeServer {
  port: number;
  close(): Promise<void>;
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" });
  res.end(text);
}

/** The body, or null when it is larger than the cap (the rest is dropped). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/** The text of the last user message, or null when the body is not a chat request with one. */
function userTextOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  const users = messages.filter((m): m is { role: "user"; content: unknown } => (m as { role?: unknown } | null)?.role === "user");
  const content = users.at(-1)?.content;
  return typeof content === "string" ? content : null;
}

const bearerOf = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  const found = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
  return found ? found[1]! : null;
};

export async function startGuardJudgeServer(options: { judge: GuardJudge; host: string; port: number }): Promise<GuardJudgeServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== PATH) return reply(res, 404);
      if (req.method !== "POST") return reply(res, 405);
      // A caller with no key costs nothing: the body is not read.
      const key = bearerOf(req);
      if (key === null) return reply(res, 401);
      const body = await readBody(req);
      if (body === null) return reply(res, 413);
      const user = userTextOf(body);
      const answer = await options.judge.review(key, user ?? "");
      if (answer.status !== 200) return reply(res, answer.status);
      return reply(res, 200, {
        id: "chatcmpl-guard-judge",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "guard_judge",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ verdict: answer.verdict, reason: answer.reason }) } }],
      });
    })().catch(() => {
      if (!res.headersSent) reply(res, 503);
      else res.end();
    });
  });
  // A guard waits for an answer for at most its own deadline; a socket that stalls is dropped.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
