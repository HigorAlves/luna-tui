// checkCall is the guard decision every runtime wraps: the rules themselves are pinned in
// runtimes/claude/guards.test.ts through guardBash and guardWrite; this pins the call shape.
import { describe, expect, it } from "vitest";

import { checkCall } from "./guards.ts";

const WRITABLE = { writable: true, branch: "task/abc" };
const READ_ONLY = { writable: false, branch: "task/abc" };

describe("checkCall", () => {
  it("allows a shell command the rules let through", () => {
    expect(checkCall({ tool: "bash", input: { command: "pnpm test" } }, READ_ONLY)).toEqual({ allow: true });
  });

  it("refuses a shell command with the rule's reason", () => {
    expect(checkCall({ tool: "bash", input: { command: "git push" } }, WRITABLE)).toEqual({ allow: false, reason: expect.stringMatching(/git push is not allowed/) });
  });

  it("guards a write by its path", () => {
    expect(checkCall({ tool: "write", input: { path: "/work/src/x.ts" } }, WRITABLE)).toEqual({ allow: true });
    expect(checkCall({ tool: "write", input: { path: "/work/src/x.ts" } }, READ_ONLY)).toEqual({ allow: false, reason: expect.stringMatching(/read-only stage/) });
  });

  it("lets a read and any other tool through", () => {
    expect(checkCall({ tool: "read", input: { path: "/etc/hosts" } }, READ_ONLY)).toEqual({ allow: true });
    expect(checkCall({ tool: "step", input: { label: "x" } }, READ_ONLY)).toEqual({ allow: true });
  });

  it("refuses a malformed input", () => {
    expect(checkCall({ tool: "bash", input: { command: 42 } }, WRITABLE)).toEqual({ allow: false, reason: expect.stringMatching(/malformed tool input/) });
    expect(checkCall({ tool: "bash", input: null }, WRITABLE)).toEqual({ allow: false, reason: expect.stringMatching(/malformed tool input/) });
    expect(checkCall({ tool: "write", input: {} }, WRITABLE)).toEqual({ allow: false, reason: expect.stringMatching(/malformed tool input/) });
  });

  it("fails closed when reading the input throws", () => {
    const hostile = {
      get command(): string {
        throw new Error("boom");
      },
    };
    expect(checkCall({ tool: "bash", input: hostile }, WRITABLE)).toEqual({ allow: false, reason: "guard failed closed: boom" });
  });
});
