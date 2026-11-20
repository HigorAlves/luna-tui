// A native subagent's tools run outside the stage's economy: only the stage's own calls reach the loop guard.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Executor, bashTool, readOnlyTools, visionGate } from "./tools.ts";

const reported: string[] = [];
let server: Server;
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    reported.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    LUNA_EVE_ECONOMY: "1",
    LUNA_EVE_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    LUNA_EVE_GUARD: JSON.stringify({ writable: true, commands: ["git log"], workRoot: "/work", outRoot: "/out", roots: { scratch: "/scratch" }, web: false }),
  });
});
afterAll(() => {
  server.close();
  process.env = saved;
});

const exec: Executor = async () => ({ exitCode: 0, stdout: "ok", stderr: "", truncated: false });
const ctx = { abortSignal: new AbortController().signal } as never;

describe("guarded tools", () => {
  it("report the stage's calls to the economy, never a native subagent's", async () => {
    await (bashTool(exec).execute as (input: { command: string }, ctx: never) => Promise<unknown>)({ command: "git log" }, ctx);
    expect(reported).toEqual(["/economy"]);
    await (readOnlyTools(["git log"], exec).bash.execute as (input: { command: string }, ctx: never) => Promise<unknown>)({ command: "git log" }, ctx);
    expect(reported).toEqual(["/economy"]);
  });
});

describe("visionGate", () => {
  const image = { content: "Image /design/0-0.png (image/png, 68 bytes).", file: { mediaType: "image/png", size: 68 }, path: "/design/0-0.png", totalLines: 0, truncated: false };
  const text = { content: "1: hello", path: "/work/a.ts", totalLines: 1, truncated: false };
  const eve = async (output: unknown) => ({ type: "content" as const, value: [{ type: "text" as const, text: String((output as { content: string }).content) }] });

  it("gives a blind engine the file's text only", async () => {
    expect(await visionGate(false, eve)(image)).toEqual({ type: "text", value: `${image.content} This engine cannot read images: judge from the text you have.` });
  });
  it("leaves a text file to eve", async () => {
    expect(await visionGate(false, eve)(text)).toEqual(await eve(text));
  });
  it("hands an image to eve on an engine with vision", async () => {
    expect(await visionGate(true, eve)(image)).toEqual(await eve(image));
  });
});
