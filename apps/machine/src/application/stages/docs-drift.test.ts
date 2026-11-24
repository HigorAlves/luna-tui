import { describe, expect, it, vi } from "vitest";

import type { StageContext, StageResult } from "../ports.ts";
import { runDocsDrift } from "./docs-drift.ts";

const context = { task: { id: "t1", worktreePath: "/wt", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
const stale = { doc: "docs/configuration.md", section: "Variables", why: "The change renamed MACHINE_PORT to LUNA_PORT.", suggestion: "Rename the row." };
const answered = (entries: unknown[]): StageResult => ({ outcome: "pass", detail: { answer: { stale: entries } } });

function deps(over: { docs?: string[]; run?: StageResult | Error } = {}) {
  const run = vi.fn(async () => {
    if (over.run instanceof Error) throw over.run;
    return over.run ?? answered([stale]);
  });
  return { run, docFiles: async () => over.docs ?? ["docs/configuration.md", "README.md"] };
}

describe("the docs-drift review beside Verify", () => {
  it("runs the pack on the change's files and the repo's doc files, and gives each stale section a nit titled for it", async () => {
    const d = deps({ run: answered([stale, { ...stale, doc: "README.md", section: null }]) });
    const outcome = await runDocsDrift(d, context, "o/a", "/wt", ["src/config.ts", "docs/configuration.md"]);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1-docs" }), { repo: "o/a", changedFiles: ["src/config.ts", "docs/configuration.md"], docFiles: ["docs/configuration.md", "README.md"] });
    expect(outcome?.findings).toEqual([
      expect.objectContaining({ path: "docs/configuration.md", severity: "nit", title: "Docs drift: docs/configuration.md Variables", body: expect.stringContaining("renamed MACHINE_PORT") }),
      expect.objectContaining({ path: "README.md", severity: "nit", title: "Docs drift: README.md" }),
    ]);
    expect(outcome?.findings[0]!.body).toContain("Rename the row.");
  });

  it("does not run when the repo has no docs, when the diff is unknown, or when it touches only docs", async () => {
    const none = deps({ docs: [] });
    expect(await runDocsDrift(none, context, "o/a", "/wt", ["src/a.ts"])).toBeNull();
    const unknown = deps();
    expect(await runDocsDrift(unknown, context, "o/a", "/wt", null)).toBeNull();
    const onlyDocs = deps();
    expect(await runDocsDrift(onlyDocs, context, "o/a", "/wt", ["docs/a.md", "README.md"])).toBeNull();
    const empty = deps();
    expect(await runDocsDrift(empty, context, "o/a", "/wt", [])).toBeNull();
    for (const d of [none, unknown, onlyDocs, empty]) expect(d.run).not.toHaveBeenCalled();
  });

  it("never throws: a failed run, a pack that did not pass or an answer that does not parse leaves no findings and a note", async () => {
    for (const run of [new Error("container died"), { outcome: "fail" } as StageResult, answered([{ doc: "x" }])]) {
      const outcome = await runDocsDrift(deps({ run }), context, "o/a", "/wt", ["src/a.ts"]);
      expect(outcome).toMatchObject({ findings: [], notes: [expect.stringContaining("docs drift did not run")] });
    }
  });
});
