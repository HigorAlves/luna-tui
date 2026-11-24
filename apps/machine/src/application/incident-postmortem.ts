// The postmortem of a resolved incident (RFC 0008, wave 5): the `postmortem` pack writes the reading and the action items, the machine
// renders the page and opens a draft that waits for the person. Approve writes it to the manager wiki and, when a Jira project is set,
// files the action items there. A pack that fails or a text the drafts refuse is logged and opens nothing; the incident job runs it again (see `postmortem` in its deps).
import { PostmortemAnswer, type ComplianceDraft, type ComplianceTarget, type PostmortemContext } from "@hardness/contracts";

import type { Incident } from "../domain/incident.ts";
import { postmortemContext, postmortemPage, postmortemPath, postmortemSummary } from "../domain/postmortem.ts";
import type { ComplianceDrafts } from "./compliance-drafts.ts";

export interface PostmortemWriterDeps {
  drafts: Pick<ComplianceDrafts, "open">;
  /** The one run of the `postmortem` pack; its answer is validated here. */
  write(context: PostmortemContext): Promise<unknown>;
  /** `owner/name` of the wiki that holds the page; null skips the postmortem. */
  wikiRepo: string | null;
  /** The Jira project for the action items; null leaves them on the page. */
  jiraProject: string | null;
  log?: (line: string) => void;
}

export function postmortemWriter(deps: PostmortemWriterDeps): (incident: Incident) => Promise<ComplianceDraft | null> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (incident) => {
    const repo = deps.wikiRepo;
    if (repo === null) {
      log(`incidents: no postmortem for ${incident.id}: set MACHINE_MANAGER_WIKI_REPO to have one written`);
      return null;
    }
    try {
      const answer = PostmortemAnswer.parse(await deps.write(postmortemContext(incident)));
      const targets: ComplianceTarget[] = [{ kind: "wiki", repo, path: postmortemPath(incident) }, ...(deps.jiraProject ? [{ kind: "jira_actions" as const, project: deps.jiraProject }] : [])];
      return await deps.drafts.open({
        id: `postmortem:${incident.id}`,
        kind: "postmortem",
        repo,
        title: `Postmortem: ${incident.title}`,
        period: null,
        summary: postmortemSummary(incident, answer),
        text: postmortemPage(incident, answer),
        targets,
      });
    } catch (error) {
      log(`incidents: no postmortem for ${incident.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}
