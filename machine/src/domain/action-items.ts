// The action items of an approved postmortem page (RFC 0008, wave 5). The person may have edited the page, so the checklist under
// "## Action items" is read back from the text, not from the writer's answer. Pure.

export interface ActionItem {
  title: string;
  owner: string | null;
  due: string | null;
}

const SUFFIX = /\s*\(owner:\s*([^,)]*?)\s*,\s*due:\s*([^)]*?)\s*\)\s*$/;
const NONE = new Set(["", "none", "unassigned"]);

/** Each unchecked `- [ ] <title> (owner: <x>, due: <date>)` line of the section, in order. The suffix is optional; `unassigned` and `none` read as null. */
export function actionItemsOf(text: string): ActionItem[] {
  const items: ActionItem[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) {
      inside = /^#{2}\s/.test(line) && heading[1]!.toLowerCase() === "action items";
      continue;
    }
    if (!inside) continue;
    const box = /^\s*[-*]\s+\[ \]\s+(.*)$/.exec(line);
    if (!box) continue;
    const rest = box[1]!.trim();
    const suffix = SUFFIX.exec(rest);
    const title = (suffix ? rest.slice(0, suffix.index) : rest).trim();
    if (title === "") continue;
    const owner = suffix?.[1] ?? "";
    const due = suffix?.[2] ?? "";
    items.push({ title, owner: NONE.has(owner.toLowerCase()) ? null : owner, due: NONE.has(due.toLowerCase()) ? null : due });
  }
  return items;
}
