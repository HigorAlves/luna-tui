// The image mounts (RFC 0013: bridged design images at /design, Verify's captures at /evidence) are read roots on every runtime:
// a pack reads them with its file tools and never writes them.
import { PACKS, StageInput, resolveEngine } from "@hardness/contracts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { guardPolicy as claudePolicy } from "../runtimes/claude/run.ts";
import { guardPolicy as evePolicy } from "../runtimes/eve/run.ts";
import { checkCall } from "./guards.ts";
import { IMAGE_ROOTS } from "./roots.ts";

const root = mkdtempSync(join(tmpdir(), "image-roots-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dirs = Object.fromEntries(["work", "out", "scratch", "in", "design"].map((d) => [d, join(root, d)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const input = StageInput.parse({ schema: 3, stage: "video_qa", pack: "video_qa", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "/r", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null }, limits: { maxTurns: 1, timeoutMs: 1 }, env: {} });
const paths = (images: string[]) => ({ factoryRoot: root, work: dirs.work!, out: dirs.out!, input: dirs.in!, scratch: dirs.scratch!, images });

describe.each([
  ["claude", (images: string[]) => claudePolicy({ pack: PACKS.video_qa, input, paths: paths(images) })],
  ["eve", (images: string[]) => evePolicy(PACKS.video_qa, { pack: PACKS.video_qa, engine: resolveEngine("codex:sol"), input, prompt: "", paths: paths(images), luna: { call: async () => null }, dry: true, emit: () => {} })],
])("%s guard policy", (_name, policy) => {
  it("reads an image under an image root", () => {
    expect(checkCall({ tool: "read", input: { path: join(dirs.design!, "0-0.png") } }, policy([dirs.design!]))).toEqual({ allow: true });
  });
  it("refuses it when the root is not mounted", () => {
    expect(checkCall({ tool: "read", input: { path: join(dirs.design!, "0-0.png") } }, policy([])).allow).toBe(false);
  });
  it("never writes there", () => {
    expect(checkCall({ tool: "write", input: { path: join(dirs.design!, "x.png") } }, policy([dirs.design!])).allow).toBe(false);
  });
});

it("names the two mounts the machine makes", () => {
  expect(IMAGE_ROOTS).toEqual(["/design", "/evidence"]);
});
