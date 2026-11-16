import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComplianceDraft } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jiraActionsWriter } from "./jira-actions.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jira-actions-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const draft = (text: string): ComplianceDraft => ({ id: "postmortem:datadog:incident:812", title: "Postmortem: Checkout failing", text }) as ComplianceDraft;
const TEXT = "# P\n\n## Action items\n\n- [ ] Add a check (owner: platform, due: 2026-12-01)\n- [ ] Alert on public buckets (owner: unassigned, due: none)\n";
const target = { kind: "jira_actions" as const, project: "OPS" };

const fakeJira = (failOn: string | null = null) => {
  let n = 0;
  const createIssue = vi.fn(async (_project: string, _type: string, summary: string, _description: string) => {
    if (summary === failOn) throw new Error("Jira refused the issue");
    n += 1;
    return { key: `OPS-${n}`, url: `https://j/OPS-${n}` };
  });
  return { createIssue };
};

describe("jiraActionsWriter", () => {
  it("files one Task per item of the approved text, saying where it came from", async () => {
    const jira = fakeJira();
    await jiraActionsWriter({ jira, stateDir: dir })(draft(TEXT), target);
    expect(jira.createIssue).toHaveBeenCalledTimes(2);
    expect(jira.createIssue.mock.calls[0]!.slice(0, 3)).toEqual(["OPS", "Task", "Add a check"]);
    const description = jira.createIssue.mock.calls[0]![3];
    expect(description).toContain("Postmortem: Checkout failing");
    expect(description).toContain("owner: platform");
    expect(description).toContain("due: 2026-12-01");
  });

  it("files only what an edited page still lists", async () => {
    const jira = fakeJira();
    await jiraActionsWriter({ jira, stateDir: dir })(draft("## Action items\n\n- [ ] Only this one\n"), target);
    expect(jira.createIssue.mock.calls.map((c) => c[2])).toEqual(["Only this one"]);
  });

  it("records each filed item by title, owner-only, and never files it twice on a retry", async () => {
    const jira = fakeJira();
    const write = jiraActionsWriter({ jira, stateDir: dir });
    await write(draft(TEXT), target);
    await write(draft(TEXT), target);
    expect(jira.createIssue).toHaveBeenCalledTimes(2);
    const folder = join(dir, "compliance", "actions");
    const [name] = await readdir(folder);
    const file = join(folder, name!);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ created: { "Add a check": "OPS-1", "Alert on public buckets": "OPS-2" } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps what it filed when a later item fails, and a retry files only the rest", async () => {
    const failing = fakeJira("Alert on public buckets");
    const write = jiraActionsWriter({ jira: failing, stateDir: dir });
    await expect(write(draft(TEXT), target)).rejects.toThrow("Jira refused the issue");
    const retry = fakeJira();
    await jiraActionsWriter({ jira: retry, stateDir: dir })(draft(TEXT), target);
    expect(retry.createIssue.mock.calls.map((c) => c[2])).toEqual(["Alert on public buckets"]);
  });

  it("does nothing for a page with no items", async () => {
    const jira = fakeJira();
    await jiraActionsWriter({ jira, stateDir: dir })(draft("## Action items\n\nNone.\n"), target);
    expect(jira.createIssue).not.toHaveBeenCalled();
  });
});
