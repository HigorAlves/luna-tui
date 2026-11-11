// The token economy's reporting from inside the eve server: a finished call goes to the runner's
// bridge, a redirect is appended to what the model reads, and a fault leaves the result as it was.
import { describe, expect, it } from "vitest";

import { type Taps, withEconomy } from "./economy.ts";

const RESULT = { exitCode: 1, stdout: "out", stderr: "FAIL x", truncated: false };
const run = async () => RESULT;

const taps = (over: Partial<Taps> = {}): Taps & { sent: Record<string, unknown>[] } => {
  const sent: Record<string, unknown>[] = [];
  return { sent, enabled: () => true, send: async (body) => (sent.push(body), {}), ...over };
};

describe("withEconomy", () => {
  it("makes no bridge call and returns the result as it is when the run has no economy", async () => {
    const t = taps({ enabled: () => false });
    const wrapped = withEconomy("bash", run, t);
    expect(await wrapped({ command: "pnpm test" }, {})).toBe(RESULT);
    expect(await wrapped({ command: "pnpm test" }, {})).toBe(RESULT);
    expect(t.sent).toEqual([]);
  });

  it("reports the finished call with its output text, capped, and ok from the exit code", async () => {
    const t = taps();
    const big = async () => ({ exitCode: 0, stdout: "x".repeat(30_000), stderr: "", truncated: false });
    await withEconomy("bash", big, t)({ command: "pnpm build" }, {});
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ tool: "bash", input: { command: "pnpm build" }, ok: true });
    expect((t.sent[0]?.output as string).length).toBe(20_000);
  });

  it("appends a redirect to the shell's stdout and leaves the rest alone", async () => {
    const t = taps({ send: async () => ({ append: "Change approach." }) });
    expect(await withEconomy("bash", run, t)({ command: "pnpm test" }, {})).toEqual({ ...RESULT, stdout: "out\n--- process check ---\nChange approach." });
  });

  it("appends to a string result and to a file's content", async () => {
    const t = taps({ send: async () => ({ append: "Stop looping." }) });
    expect(await withEconomy("grep", async () => "a:1", t)({}, {})).toBe("a:1\n--- process check ---\nStop looping.");
    expect(await withEconomy("read_file", async () => ({ content: "c", path: "p" }), t)({}, {})).toEqual({ content: "c\n--- process check ---\nStop looping.", path: "p" });
  });

  it("holds a redirect a result has no text to carry, and tells it with the next result that has", async () => {
    const answers = [{ append: "Change approach." }, {}, {}];
    const t = taps({ send: async () => answers.shift() ?? {} });
    const written = { existed: true, path: "src/a.ts" };
    expect(await withEconomy("write_file", async () => written, t)({}, {})).toBe(written);
    expect(await withEconomy("bash", run, t)({ command: "pnpm test" }, {})).toEqual({ ...RESULT, stdout: "out\n--- process check ---\nChange approach." });
    expect(await withEconomy("bash", run, t)({ command: "pnpm test" }, {})).toBe(RESULT);
  });

  it("tells the model the run is ending on a stop", async () => {
    const t = taps({ send: async () => ({ stop: true }) });
    const out = (await withEconomy("bash", run, t)({ command: "pnpm test" }, {})) as typeof RESULT;
    expect(out.stdout).toMatch(/--- process check ---\n.*run is ending/);
  });

  it("leaves the result untouched when the bridge fails or answers nonsense", async () => {
    for (const send of [async () => Promise.reject(new Error("down")), async () => "nope", async () => null]) {
      expect(await withEconomy("bash", run, taps({ send }))({ command: "pnpm test" }, {})).toBe(RESULT);
    }
  });

  it("does not wait on a bridge that never answers", async () => {
    const t = taps({ send: () => new Promise(() => {}), waitMs: 50 });
    const started = Date.now();
    expect(await withEconomy("bash", run, t)({ command: "pnpm test" }, {})).toBe(RESULT);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a failed call and rethrows its error", async () => {
    const t = taps();
    await expect(withEconomy("bash", async () => Promise.reject(new Error("boom")), t)({ command: "x" }, {})).rejects.toThrow("boom");
    expect(t.sent[0]).toMatchObject({ tool: "bash", ok: false, output: "boom" });
  });
});
