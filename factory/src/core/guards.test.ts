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

  describe("with a command allow-list (a runtime without the SDK's own Bash rules)", () => {
    const LISTED = { ...READ_ONLY, commands: ["git diff", "pnpm", "cat"] };

    it("allows a command, and every part of a chain, that starts with a listed prefix", () => {
      expect(checkCall({ tool: "bash", input: { command: "git diff --stat" } }, LISTED)).toEqual({ allow: true });
      expect(checkCall({ tool: "bash", input: { command: "pnpm test && cat out.txt | cat" } }, LISTED)).toEqual({ allow: true });
    });

    it("refuses a command, or any part of a chain, off the list, naming it", () => {
      expect(checkCall({ tool: "bash", input: { command: "git status" } }, LISTED)).toEqual({ allow: false, reason: expect.stringMatching(/`git status` is not on this stage's command allow-list \(git diff, pnpm, cat\)/) });
      expect(checkCall({ tool: "bash", input: { command: "pnpm test; cd /x" } }, LISTED)).toEqual({ allow: false, reason: expect.stringMatching(/`cd \/x`/) });
      expect(checkCall({ tool: "bash", input: { command: "pnpmx" } }, LISTED)).toEqual({ allow: false, reason: expect.stringMatching(/not on this stage's command allow-list/) });
    });

    it("still applies the rules to a listed command", () => {
      expect(checkCall({ tool: "bash", input: { command: "cat x > /etc/y" } }, LISTED)).toEqual({ allow: false, reason: expect.stringMatching(/writing to \/etc\/y/) });
    });
  });

  describe("with denied roots (the Codex home, which the model's shell could read)", () => {
    const DENIED = { ...WRITABLE, deniedRoots: ["/tmp/.codex"] };

    it("refuses reading, writing or naming a path under them", () => {
      expect(checkCall({ tool: "read", input: { path: "/tmp/.codex/auth.json" } }, DENIED)).toEqual({ allow: false, reason: expect.stringMatching(/\/tmp\/\.codex is off limits/) });
      expect(checkCall({ tool: "read", input: { path: "/tmp/x/../.codex/auth.json" } }, DENIED)).toMatchObject({ allow: false });
      expect(checkCall({ tool: "write", input: { path: "/tmp/.codex/config.toml" } }, DENIED)).toMatchObject({ allow: false });
      expect(checkCall({ tool: "bash", input: { command: "cat /tmp/.codex/auth.json" } }, DENIED)).toMatchObject({ allow: false });
      expect(checkCall({ tool: "bash", input: { command: 'cat "/tmp/.co"dex/auth.json' } }, DENIED)).toMatchObject({ allow: false });
      expect(checkCall({ tool: "bash", input: { command: "cat ~/.codex/auth.json" } }, DENIED)).toMatchObject({ allow: false });
    });

    it("leaves everything else alone", () => {
      expect(checkCall({ tool: "read", input: { path: "/work/src/codex.ts" } }, DENIED)).toEqual({ allow: true });
      expect(checkCall({ tool: "bash", input: { command: "cat /tmp/notes.txt" } }, DENIED)).toEqual({ allow: true });
    });
  });
});
