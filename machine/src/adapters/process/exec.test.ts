import { describe, expect, it } from "vitest";

import { exec, OUTPUT_CAP } from "./exec.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("exec", () => {
  it("resolves with the exit code and output instead of throwing", async () => {
    expect(await exec("sh", ["-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("kills the whole process group on timeout, not only the shell it started", async () => {
    // A test runner the repo's `pnpm test` spawns would otherwise outlive the timeout and
    // keep the slot's CPU, as `sleep` stands in for here.
    const result = await exec("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 200 });
    const grandchild = Number(result.stdout.trim());
    expect(result.code).not.toBe(0);
    expect(grandchild).toBeGreaterThan(0);
    // The kill is asynchronous to the callback: give it a moment, never longer than needed.
    const deadline = Date.now() + 2000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(grandchild)).toBe(false);
  });

  it("kills the group on abort too", async () => {
    const controller = new AbortController();
    const pending = exec("sh", ["-c", "sleep 30 & echo $!; wait"], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await pending;
    const grandchild = Number(result.stdout.trim());
    const deadline = Date.now() + 2000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(grandchild)).toBe(false);
  });

  it("keeps only the tail of an output bigger than the cap its caller set, so a container's output cannot fill the machine's memory", async () => {
    const result = await exec("sh", ["-c", "yes 0123456789abcdef | head -c 6000000; echo THE-END"], { outputCap: OUTPUT_CAP });
    expect(result.stdout.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(result.stdout.length).toBeGreaterThan(OUTPUT_CAP - 8);
    expect(result.stdout.trimEnd().endsWith("THE-END")).toBe(true);
  });

  it("keeps every byte when no cap is set: a file list or a diff the machine reads is never cut without its caller asking", async () => {
    const result = await exec("sh", ["-c", "echo THE-START; yes 0123456789abcdef | head -c 6000000"]);
    expect(result.stdout.startsWith("THE-START\n")).toBe(true);
    expect(result.stdout.length).toBe(6000000 + "THE-START\n".length);
  });

  it("keeps a character whole when it arrives split across two chunks", async () => {
    const result = await exec("sh", ["-c", "printf '\\303'; sleep 0.2; printf '\\251\\n'"]);
    expect(result.stdout).toBe("é\n");
  });
});
