// The merge commit's title and message from `ship.merge.commit_template` (luna.yaml). Five placeholders, each value flattened through `safe()` so text a
// person or a model wrote cannot add a line, a mention, an issue reference or a link; nothing a model wrote (the pack's summary) is a placeholder.
import { safe } from "./evidence-markdown.ts";

/** The address of a PR on github.com: the machine builds it from the slug and the number, so it is printed as it is. */
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
export const TITLE_CAP = 200;
export const MESSAGE_CAP = 4000;

export interface CommitVars {
  title: string;
  number: number;
  card: string;
  risk: string;
  url: string;
}

/** The template's first line is the commit title, the rest the message. A null or empty template renders nothing: the host's own commit text stands. */
export function renderCommitTemplate(template: string | null, vars: CommitVars): { title: string; message: string } | null {
  if (template === null || template.trim() === "") return null;
  const values: Record<string, string> = { title: safe(vars.title), number: String(vars.number), card: safe(vars.card), risk: safe(vars.risk), url: PR_URL.test(vars.url) ? vars.url : safe(vars.url) };
  const filled = template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]! : whole));
  const [first = "", ...rest] = filled.replace(/\r\n?/g, "\n").split("\n");
  return { title: first.trim().slice(0, TITLE_CAP), message: rest.join("\n").trim().slice(0, MESSAGE_CAP) };
}
