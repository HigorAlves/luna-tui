import type { Ledger, RunEvent } from "@hardness/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { lunaHandlers } from "./luna-tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

/** A /work repo with a base commit holding two files, a checks dir, and a luna with a three-slice ledger. */
function scratch(wait = 2000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "helper-tools-")));
  const work = join(root, "work");
  const checks = join(root, "out", "checks");
  mkdirSync(checks, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "api.ts"), "api\n");
  writeFileSync(join(work, "page.tsx"), "page\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  const events: RunEvent[] = [];
  let bundled = 0;
  const luna = lunaHandlers({
    ledgerPath: join(root, "ledger.json"),
    ledger: { schema: 1, slices: [1, 2, 3].map((id) => ({ id, title: `slice ${id}`, status: "pending", commit: null })) } as Ledger,
    decisions: [],
    emit: (e) => events.push(e),
    checksDir: checks,
    checkWaitMs: wait,
    work,
    bundleNow: () => void bundled++,
  });
  return { root, work, checks, luna, events, bundled: () => bundled };
}

/** The fake machine: answers a request file by name, once. */
async function answer(checks: string, pattern: RegExp, reply: (m: RegExpExecArray, body: Record<string, unknown>) => Record<string, unknown> | null, out: (m: RegExpExecArray) => string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const name = readdirSync(checks).find((f) => pattern.test(f));
    if (name) {
      const m = pattern.exec(name)!;
      const body = JSON.parse(readFileSync(join(checks, name), "utf8")) as Record<string, unknown>;
      const r = reply(m, body);
      if (r) writeFileSync(join(checks, out(m)), JSON.stringify(r));
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no request ${pattern}`);
}
const delegateOk = (checks: string, extra: Record<string, unknown> = {}) =>
  answer(checks, /^helper-request-([0-9a-f]{8})-(\d+)\.json$/, () => ({ ok: true, handle: "h1", branch: "luna-helper-3", base: "b", locks: ["page.tsx"], ...extra }), (m) => `helper-answer-${m[1]}-${m[2]}.json`);
const state = (checks: string, slice: number, s: Record<string, unknown>) => writeFileSync(join(checks, `helper-state-${slice}.json`), JSON.stringify(s));

/** The machine's picked bundle: a clone of /work with a commit on top, bundled over /work's HEAD by the picked ref's name. */
function pickedBundle(root: string, work: string, dest: string, files: Record<string, string>) {
  const clone = join(root, "m");
  if (!existsSync(clone)) execFileSync("git", ["clone", "-q", work, clone]);
  const p = git(work, "rev-parse", "HEAD");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(clone, f), c);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "ui");
  const tip = git(clone, "rev-parse", "HEAD");
  git(clone, "update-ref", "refs/luna/helper/t1/3-picked", tip);
  execFileSync("git", ["-C", clone, "bundle", "create", "--quiet", dest, "refs/luna/helper/t1/3-picked", `^${p}`]);
  return { tip, p };
}
const pickHandlers = (root: string, work: string, checks: string, files: Record<string, string>, ackReply: Record<string, unknown> | null = { ok: true }) => {
  const acks: unknown[] = [];
  const asked: Record<string, unknown>[] = [];
  let tip = "";
  const run = (async () => {
    await answer(checks, /^pick-request-([0-9a-f]{8})-(\d+)\.json$/, (m, body) => {
      asked.push(body);
      const made = pickedBundle(root, work, join(checks, "pick-1.bundle"), files);
      tip = made.tip;
      return { ok: true, tip: made.tip, picked: [made.tip], bundle: "pick-1.bundle" };
    }, (m) => `pick-answer-${m[1]}-${m[2]}.json`);
    await answer(checks, /^pick-ack-([0-9a-f]{8})-(\d+)\.json$/, (_m, body) => {
      acks.push(body);
      return ackReply;
    }, (m) => `pick-done-${m[1]}-${m[2]}.json`);
  })();
  return { run, acks, asked, tip: () => tip };
};

describe("slice_delegate", () => {
  it("writes helper-request-<nonce>-<n>.json and returns the machine's answer as it is, the slice now the ui-designer's", async () => {
    const { luna, checks } = scratch();
    const machine = delegateOk(checks);
    const got = await luna.call("slice_delegate", { slice: 3, message: "match the frame" });
    await machine;
    expect(got).toMatchObject({ ok: true, handle: "h1", locks: ["page.tsx"] });
    const req = readdirSync(checks).find((f) => f.startsWith("helper-request-"))!;
    expect(JSON.parse(readFileSync(join(checks, req), "utf8"))).toEqual({ n: 1, slice: 3, message: "match the frame" });
    expect(luna.state.ledger.slices.find((s) => s.id === 3)!.owner).toBe("ui-designer");
  });

  it("returns the refusal and leaves the slice the implementer's", async () => {
    const { luna, checks } = scratch();
    const machine = answer(checks, /^helper-request-([0-9a-f]{8})-(\d+)\.json$/, () => ({ ok: false, error: "slice 3 is not a UI slice" }), (m) => `helper-answer-${m[1]}-${m[2]}.json`);
    expect(await luna.call("slice_delegate", { slice: 3 })).toEqual({ ok: false, error: "slice 3 is not a UI slice" });
    await machine;
    expect(luna.state.ledger.slices[2]!.owner).toBeUndefined();
  });

  it("says no one answered when the machine stays silent", async () => {
    const { luna } = scratch(60);
    expect(await luna.call("slice_delegate", { slice: 3 })).toEqual({ ok: false, error: "no one answered; build the slice yourself" });
    expect(luna.state.ledger.slices[2]!.owner).toBeUndefined();
  });

  it("refuses a slice that is not in the ledger, and writes no request", async () => {
    const { luna, checks } = scratch();
    expect(await luna.call("slice_delegate", { slice: 9 })).toMatchObject({ error: expect.stringContaining("no slice 9") });
    expect(readdirSync(checks)).toEqual([]);
  });
});

describe("slice_wait", () => {
  it("returns running when the time is up, with the machine's attempt", async () => {
    const { luna, checks } = scratch();
    void delegateOk(checks);
    await luna.call("slice_delegate", { slice: 3 });
    state(checks, 3, { state: "running", attempt: 1 });
    const t = Date.now();
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 1 })).toEqual({ state: "running", attempt: 1 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  it("returns a settled state at once, with its summary", async () => {
    const { luna, checks } = scratch();
    void delegateOk(checks);
    await luna.call("slice_delegate", { slice: 3 });
    state(checks, 3, { state: "refused", attempt: 2, summary: "it touched your files" });
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 5 })).toEqual({ state: "refused", attempt: 2, summary: "it touched your files" });
  });

  it("keeps waiting while the machine has the helper building again after a conflict, and answers when the state moves on", async () => {
    const { luna, checks } = scratch();
    void delegateOk(checks);
    await luna.call("slice_delegate", { slice: 3 });
    state(checks, 3, { state: "conflict_rerun", attempt: 2 });
    setTimeout(() => state(checks, 3, { state: "refused", attempt: 2, summary: "no" }), 300);
    const t = Date.now();
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 5 })).toEqual({ state: "refused", attempt: 2, summary: "no" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    // and when the time is up it says so, in the machine's own word
    state(checks, 3, { state: "conflict_rerun", attempt: 2 });
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 1 })).toEqual({ state: "conflict_rerun", attempt: 2 });
  });

  it("caps the wait at 240 seconds by its input", async () => {
    const { luna } = scratch();
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 241 })).toMatchObject({ error: expect.stringContaining("waitSeconds") });
  });

  it("answers a slice no helper holds with a plain error", async () => {
    const { luna } = scratch();
    expect(await luna.call("slice_wait", { slice: 3, waitSeconds: 1 })).toMatchObject({ error: expect.stringContaining("no helper") });
  });
});

describe("the pick handshake", () => {
  const delegated = async (s: ReturnType<typeof scratch>) => {
    void delegateOk(s.checks);
    await s.luna.call("slice_delegate", { slice: 3 });
  };

  it("bundles the implementer's commits, sends its head, fetches the picked bundle by ref, fast-forwards and acks; a dirty unrelated file stays", async () => {
    const s = scratch();
    await delegated(s);
    writeFileSync(join(s.work, "api.ts"), "api edited, uncommitted\n");
    const p = git(s.work, "rev-parse", "HEAD");
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const machine = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" });
    const got = await s.luna.call("slice_wait", { slice: 3, waitSeconds: 5 });
    await machine.run;
    expect(machine.asked[0]).toEqual({ n: expect.any(Number), slice: 3, head: p });
    expect(s.bundled()).toBeGreaterThan(0);
    expect(git(s.work, "rev-parse", "HEAD")).toBe(machine.tip());
    expect(readFileSync(join(s.work, "page.tsx"), "utf8")).toBe("page v2\n");
    expect(readFileSync(join(s.work, "api.ts"), "utf8")).toBe("api edited, uncommitted\n");
    expect(machine.acks).toEqual([{ n: expect.any(Number), slice: 3, head: machine.tip() }]);
    const slice = s.luna.state.ledger.slices[2]!;
    expect(slice).toMatchObject({ status: "committed", commit: machine.tip(), owner: "ui-designer", note: expect.stringContaining("picked by the machine") });
    expect(JSON.parse(readFileSync(join(s.root, "ledger.json"), "utf8")).slices[2].status).toBe("committed");
    expect(s.events.map((e) => e.kind)).toContain("slice.committed");
    expect(got).toMatchObject({ state: "committed" });
  });

  it("marks the slice committed only after the machine confirms: nothing is written before pick-done", async () => {
    const s = scratch();
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    let atAck: string | undefined;
    let eventsAtAck = 0;
    const run = (async () => {
      await answer(s.checks, /^pick-request-([0-9a-f]{8})-(\d+)\.json$/, () => {
        const made = pickedBundle(s.root, s.work, join(s.checks, "pick-1.bundle"), { "page.tsx": "page v2\n" });
        return { ok: true, tip: made.tip, picked: [made.tip], bundle: "pick-1.bundle" };
      }, (m) => `pick-answer-${m[1]}-${m[2]}.json`);
      await answer(s.checks, /^pick-ack-([0-9a-f]{8})-(\d+)\.json$/, () => {
        atAck = JSON.parse(readFileSync(join(s.root, "ledger.json"), "utf8")).slices?.[2]?.status ?? "none";
        eventsAtAck = s.events.filter((e) => e.kind === "slice.committed").length;
        return { ok: true };
      }, (m) => `pick-done-${m[1]}-${m[2]}.json`);
    })();
    await s.luna.call("slice_wait", { slice: 3, waitSeconds: 5 });
    await run;
    expect(atAck).not.toBe("committed");
    expect(eventsAtAck).toBe(0);
    expect(s.luna.state.ledger.slices[2]!.status).toBe("committed");
  });

  it("puts HEAD back when the machine refuses the ack: the slice stays held and not committed, and the next call picks again", async () => {
    const s = scratch();
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const before = git(s.work, "rev-parse", "HEAD");
    writeFileSync(join(s.work, "api.ts"), "api edited, uncommitted\n");
    const first = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" }, { ok: false, reason: "the branch moved" });
    const got = (await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 })) as { error?: string };
    await first.run;
    expect(got.error).toContain("the branch moved");
    expect(git(s.work, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(s.work, "page.tsx"), "utf8")).toBe("page\n");
    expect(readFileSync(join(s.work, "api.ts"), "utf8")).toBe("api edited, uncommitted\n");
    expect(s.luna.state.ledger.slices[2]).toMatchObject({ status: "pending", owner: "ui-designer" });
    expect(s.events.map((e) => e.kind)).not.toContain("slice.committed");
    // the machine is back at `returned`; the next call picks again
    for (const f of readdirSync(s.checks).filter((x) => /^pick-/.test(x))) execFileSync("rm", [join(s.checks, f)]);
    const second = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v3\n" });
    await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 });
    await second.run;
    expect(s.luna.state.ledger.slices[2]).toMatchObject({ status: "committed", owner: "ui-designer", commit: second.tip() });
  });

  it("keeps the merge when the machine never confirms, says to call slice_wait, and finishes once the state file says committed", async () => {
    const s = scratch(300);
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const machine = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" }, null);
    const got = (await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 })) as { error?: string };
    await machine.run;
    expect(got.error).toContain("has not confirmed the pick of slice 3");
    expect(got.error).toContain("slice_wait");
    expect(git(s.work, "rev-parse", "HEAD")).toBe(machine.tip());
    expect(s.luna.state.ledger.slices[2]!.status).toBe("pending");
    // the machine's CAS went through after all
    state(s.checks, 3, { state: "committed", attempt: 1 });
    const listed = (await s.luna.call("slice_list", {})) as Ledger;
    expect(listed.slices[2]).toMatchObject({ status: "committed", owner: "ui-designer", commit: machine.tip() });
    expect(JSON.parse(readFileSync(join(s.root, "ledger.json"), "utf8")).slices[2].status).toBe("committed");
    expect(s.events.filter((e) => e.kind === "slice.committed")).toHaveLength(1);
  });

  it("reports a slice the machine holds as committed when HEAD does not contain the picked tip", async () => {
    const s = scratch(300);
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const machine = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" }, null);
    await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 });
    await machine.run;
    git(s.work, "reset", "--hard", "-q", "HEAD~1");
    state(s.checks, 3, { state: "committed", attempt: 1 });
    const got = (await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 })) as { error?: string };
    expect(got.error).toContain("slice 3");
    expect(s.luna.state.ledger.slices[2]!.status).toBe("pending");
  });

  it("runs first in slice_list, so the slice shows as committed", async () => {
    const s = scratch();
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const machine = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" });
    const listed = (await s.luna.call("slice_list", {})) as Ledger;
    await machine.run;
    expect(listed.slices[2]).toMatchObject({ status: "committed", owner: "ui-designer" });
  });

  it("refuses the merge when a picked file has uncommitted edits: lists the file, acks nothing, and the next call retries", async () => {
    const s = scratch();
    await delegated(s);
    writeFileSync(join(s.work, "page.tsx"), "my own edit\n");
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const first = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" });
    const got = (await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 })) as { error: string };
    await first.run.catch(() => {});
    expect(got.error).toContain("page.tsx");
    expect(got.error).toContain("git restore");
    expect(readdirSync(s.checks).some((f) => f.startsWith("pick-ack-"))).toBe(false);
    expect(s.luna.state.ledger.slices[2]!.status).toBe("pending");
    expect(readFileSync(join(s.work, "page.tsx"), "utf8")).toBe("my own edit\n");
    // the person restores the file; the next call picks again
    git(s.work, "checkout", "--", "page.tsx");
    for (const f of readdirSync(s.checks).filter((x) => /^pick-/.test(x))) execFileSync("rm", [join(s.checks, f)]);
    const second = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v3\n" });
    await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 });
    await second.run;
    expect(s.luna.state.ledger.slices[2]).toMatchObject({ status: "committed", owner: "ui-designer" });
  }, 15000);

  it("tries once more within the call when the machine says retry", async () => {
    const s = scratch();
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const first = answer(s.checks, /^pick-request-([0-9a-f]{8})-(\d+)\.json$/, () => ({ ok: false, retry: true }), (m) => `pick-answer-${m[1]}-${m[2]}.json`);
    const wait = s.luna.call("slice_wait", { slice: 3, waitSeconds: 5 });
    await first;
    // the second request has a new number; take the answer only for it
    for (let i = 0; i < 200 && !readdirSync(s.checks).some((f) => /^pick-request-[0-9a-f]{8}-2\.json$/.test(f)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(s.checks).some((f) => /^pick-request-[0-9a-f]{8}-2\.json$/.test(f))).toBe(true);
    const name = readdirSync(s.checks).find((f) => /^pick-request-[0-9a-f]{8}-2\.json$/.test(f))!;
    const m = /^pick-request-([0-9a-f]{8})-2\.json$/.exec(name)!;
    const made = pickedBundle(s.root, s.work, join(s.checks, "pick-2.bundle"), { "page.tsx": "page v2\n" });
    writeFileSync(join(s.checks, `pick-answer-${m[1]}-2.json`), JSON.stringify({ ok: true, tip: made.tip, picked: [made.tip], bundle: "pick-2.bundle" }));
    await answer(s.checks, /^pick-ack-([0-9a-f]{8})-(\d+)\.json$/, () => ({ ok: true }), (a) => `pick-done-${a[1]}-${a[2]}.json`);
    await wait;
    expect(s.luna.state.ledger.slices[2]!.status).toBe("committed");
  });

  it("does not fast-forward to a tip the bundle does not hold", async () => {
    const s = scratch();
    await delegated(s);
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const head = git(s.work, "rev-parse", "HEAD");
    void answer(s.checks, /^pick-request-([0-9a-f]{8})-(\d+)\.json$/, () => {
      pickedBundle(s.root, s.work, join(s.checks, "pick-1.bundle"), { "page.tsx": "x\n" });
      return { ok: true, tip: "a".repeat(40), picked: [], bundle: "pick-1.bundle" };
    }, (m) => `pick-answer-${m[1]}-${m[2]}.json`);
    const got = (await s.luna.call("slice_wait", { slice: 3, waitSeconds: 1 })) as { error?: string };
    expect(got.error).toBeDefined();
    expect(git(s.work, "rev-parse", "HEAD")).toBe(head);
    expect(s.luna.state.ledger.slices[2]!.status).toBe("pending");
  });

  it("never runs a hook of the repository while it merges", async () => {
    const s = scratch();
    await delegated(s);
    const hooks = join(s.work, ".git", "hooks");
    for (const h of ["post-merge", "pre-merge-commit"]) {
      writeFileSync(join(hooks, h), `#!/bin/sh\ntouch "${s.root}/hook-ran"\n`, { mode: 0o755 });
    }
    state(s.checks, 3, { state: "returned", attempt: 1 });
    const machine = pickHandlers(s.root, s.work, s.checks, { "page.tsx": "page v2\n" });
    await s.luna.call("slice_wait", { slice: 3, waitSeconds: 5 });
    await machine.run;
    expect(s.luna.state.ledger.slices[2]!.status).toBe("committed");
    expect(existsSync(join(s.root, "hook-ran"))).toBe(false);
  });
});

describe("what a helper out changes in the other tools", () => {
  it("refuses slice_set on the helper's slice", async () => {
    const s = scratch();
    void delegateOk(s.checks);
    await s.luna.call("slice_delegate", { slice: 3 });
    state(s.checks, 3, { state: "running", attempt: 1 });
    expect(await s.luna.call("slice_set", { id: 3, status: "green" })).toEqual({ error: "slice 3 is the ui-designer's; call slice_wait" });
    expect(s.luna.state.ledger.slices[2]!.status).toBe("pending");
  });

  it("answers wait to scope_check while a helper is running, and writes no request", async () => {
    const s = scratch();
    void delegateOk(s.checks);
    await s.luna.call("slice_delegate", { slice: 3 });
    state(s.checks, 3, { state: "running", attempt: 1 });
    expect(await s.luna.call("scope_check", { diffSummary: "d", outOfMap: [] })).toEqual({ verdict: "wait", problems: ["slice 3 is with ui-designer; call slice_wait"] });
    expect(existsSync(join(s.checks, "scope-request.json"))).toBe(false);
  });

  it("lets scope_check through once the helper's slice is committed", async () => {
    const s = scratch(50);
    void delegateOk(s.checks);
    await s.luna.call("slice_delegate", { slice: 3 });
    state(s.checks, 3, { state: "committed", attempt: 1 });
    s.luna.state.ledger.slices[2]!.status = "committed";
    expect(await s.luna.call("scope_check", { diffSummary: "d", outOfMap: [] })).toMatchObject({ verdict: "skipped" });
  });

  it("gives a slice a run started with as the ui-designer's, no helper being out, back to the implementer", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "helper-reset-")));
    const luna = lunaHandlers({
      ledgerPath: join(root, "ledger.json"),
      ledger: { schema: 1, slices: [{ id: 1, title: "a", status: "red", commit: null, owner: "ui-designer" }, { id: 2, title: "b", status: "committed", commit: "abc", owner: "ui-designer" }] },
      decisions: [],
      emit: () => {},
      checksDir: join(root, "checks"),
      work: root,
    });
    expect(luna.state.ledger.slices[0]).toMatchObject({ status: "pending", owner: "implementer", note: expect.stringContaining("ui-designer") });
    expect(luna.state.ledger.slices[1]).toMatchObject({ status: "committed", owner: "ui-designer" });
  });
});

