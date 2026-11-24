// The `jira_actions` target of an approved postmortem (RFC 0008, wave 5): one Jira Task per item of the page's "## Action items"
// checklist, read from the text as the person approved it. A record under `<stateDir>/compliance/actions/` maps each filed title to
// its key, saved after every item, so a retry of a draft that failed halfway never files an item twice.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { actionItemsOf } from "../domain/action-items.ts";
import { COMPLIANCE_DIR, type TargetWriter } from "./compliance-drafts.ts";
import type { Jira } from "./jira.ts";

const RecordSchema = z.object({ schema: z.literal(1), created: z.record(z.string(), z.string()) });

export interface JiraActionsDeps {
  jira: Pick<Jira, "createIssue">;
  stateDir: string;
}

const fileNameOf = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}.json`;

export function jiraActionsWriter(deps: JiraActionsDeps): TargetWriter<"jira_actions"> {
  return async (draft, target) => {
    const items = actionItemsOf(draft.text);
    if (items.length === 0) return;
    const folder = join(deps.stateDir, COMPLIANCE_DIR, "actions");
    const file = join(folder, fileNameOf(draft.id));
    const created = await load(file);
    for (const item of items) {
      if (item.title in created) continue;
      const description = [`Filed from the postmortem page "${draft.title}", approved in the Compliance view.`, "", `owner: ${item.owner ?? "unassigned"}`, `due: ${item.due ?? "none"}`].join("\n");
      const issue = await deps.jira.createIssue(target.project, "Task", item.title, description);
      created[item.title] = issue.key;
      await save(folder, file, created);
    }
  };
}

/** A damaged or missing record is empty: nothing is known to be filed. */
async function load(file: string): Promise<Record<string, string>> {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) return parsed.data.created;
  } catch {
    // No file, or not JSON.
  }
  return {};
}

async function save(folder: string, file: string, created: Record<string, string>): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ schema: 1, created }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
