// Atlassian Document Format, both ways. Jira stores descriptions and comments as ADF (a JSON
// tree); the machine thinks in markdown. Reading: paragraphs, headings, lists, code blocks,
// links and cards, bold and code marks; anything else is reduced to its text. Writing: what
// the machine says in a comment or an issue it creates: paragraphs separated by blank lines,
// `- ` bullets, `- [ ]` task lists, `1.` ordered lists, `#` headings, `**bold**`, `` `code` ``
// and bare urls as links. Pure.

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

const text = (node: AdfNode): string => {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return String(node.attrs?.text ?? "");
  if (node.type === "emoji") return String(node.attrs?.shortName ?? node.attrs?.text ?? "");
  return (node.content ?? []).map(text).join("");
};

/** One inline node as markdown: its marks (link, bold, code) around its text. */
function inline(node: AdfNode): string {
  if (node.type === "inlineCard") return cardLink(String(node.attrs?.url ?? ""));
  if (node.type !== "text") return text(node);
  let out = node.text ?? "";
  for (const mark of node.marks ?? []) {
    if (mark.type === "code") out = `\`${out}\``;
    else if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `_${out}_`;
    else if (mark.type === "link") out = `[${out}](${String(mark.attrs?.href ?? "")})`;
  }
  return out;
}

const cardLink = (url: string): string => (url ? `[${url}](${url})` : "");

const inlines = (node: AdfNode): string => (node.content ?? []).map(inline).join("");

/** A block node as markdown lines; `indent` prefixes nested list items. */
function block(node: AdfNode, indent = ""): string[] {
  switch (node.type) {
    case "paragraph":
      return [indent + inlines(node)];
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return [`${"#".repeat(level)} ${inlines(node)}`];
    }
    case "bulletList":
      return (node.content ?? []).flatMap((item) => listItem(item, `${indent}- `));
    case "orderedList":
      return (node.content ?? []).flatMap((item, i) => listItem(item, `${indent}${i + 1}. `));
    case "taskList":
      return (node.content ?? []).flatMap((item) => [`${indent}- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inlines(item)}`]);
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return [`\`\`\`${language}`, text(node), "```"];
    }
    case "blockquote":
      return (node.content ?? []).flatMap((child) => block(child).map((line) => `> ${line}`));
    case "rule":
      return ["---"];
    case "blockCard":
    case "embedCard":
      return [cardLink(String(node.attrs?.url ?? ""))];
    case "mediaSingle":
    case "mediaGroup":
      return ["(attachment)"];
    case "table":
      return (node.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => text(cell).trim()).join(" | ")} |`);
    default:
      return node.content ? (node.content ?? []).flatMap((child) => block(child, indent)) : [text(node)];
  }
}

/** A list item: its first paragraph after the marker, nested blocks indented under it. */
function listItem(item: AdfNode, marker: string): string[] {
  const [first, ...rest] = item.content ?? [];
  const pad = " ".repeat(marker.length);
  const head = first ? block(first).join("\n") : "";
  const tail = rest.flatMap((child) => block(child, pad));
  return [`${marker}${head}`, ...tail];
}

/** The markdown a document means. A string (an old wiki-markup field, or a test) is returned as is. */
export function adfToMarkdown(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return doc;
  const root = doc as AdfNode;
  const blocks = (root.content ?? []).map((node) => block(node).join("\n"));
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

const URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
/** `**bold**` and `` `code` `` spans; everything between is plain text with bare urls as links. */
const SPANS = /(\*\*[^*]+\*\*|`[^`]+`)/;

/** Text with bare urls as link marks, plus `marks` on every node. */
function linkedNodes(line: string, marks: AdfNode["marks"] = []): AdfNode[] {
  const nodes: AdfNode[] = [];
  const node = (value: string, extra: NonNullable<AdfNode["marks"]> = []): AdfNode => {
    const all = [...(marks ?? []), ...extra];
    return all.length > 0 ? { type: "text", text: value, marks: all } : { type: "text", text: value };
  };
  let at = 0;
  for (const match of line.matchAll(URL)) {
    const start = match.index;
    if (start > at) nodes.push(node(line.slice(at, start)));
    nodes.push(node(match[0], [{ type: "link", attrs: { href: match[0] } }]));
    at = start + match[0].length;
  }
  if (at < line.length) nodes.push(node(line.slice(at)));
  return nodes;
}

/** One line as inline nodes: `**bold**` carries a strong mark, `` `code` `` a code mark, bare urls link. */
function inlineNodes(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  for (const part of line.split(SPANS)) {
    if (part === "") continue;
    if (part.startsWith("**") && part.endsWith("**")) nodes.push(...linkedNodes(part.slice(2, -2), [{ type: "strong" }]));
    else if (part.startsWith("`") && part.endsWith("`")) nodes.push({ type: "text", text: part.slice(1, -1), marks: [{ type: "code" }] });
    else nodes.push(...linkedNodes(part));
  }
  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

const paragraph = (line: string): AdfNode => ({ type: "paragraph", content: inlineNodes(line) });

/**
 * The document for a plain text: blank lines split paragraphs, consecutive `- ` lines form a
 * bullet list, `- [ ]` / `- [x]` lines a task list (so Jira shows checkboxes), `1.` lines an
 * ordered list, `#` lines headings; `**bold**`, `` `code` `` and bare urls are marked inline.
 */
export function markdownToAdf(text: string): AdfDoc {
  const content: AdfNode[] = [];
  let lists = 0;
  let items = 0;
  let bullets: AdfNode[] = [];
  let tasks: AdfNode[] = [];
  let ordered: AdfNode[] = [];
  let lines: string[] = [];
  const flushLists = () => {
    if (bullets.length > 0) content.push({ type: "bulletList", content: bullets });
    if (tasks.length > 0) content.push({ type: "taskList", attrs: { localId: `list-${++lists}` }, content: tasks });
    if (ordered.length > 0) content.push({ type: "orderedList", attrs: { order: 1 }, content: ordered });
    bullets = [];
    tasks = [];
    ordered = [];
  };
  const flushLines = () => {
    if (lines.length > 0) content.push(paragraph(lines.join(" ")));
    lines = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (task) {
      flushLines();
      if (bullets.length > 0 || ordered.length > 0) flushLists();
      tasks.push({ type: "taskItem", attrs: { localId: `item-${++items}`, state: task[1] === " " ? "TODO" : "DONE" }, content: inlineNodes(task[2]!) });
    } else if (bullet) {
      flushLines();
      if (tasks.length > 0 || ordered.length > 0) flushLists();
      bullets.push({ type: "listItem", content: [paragraph(bullet[1]!)] });
    } else if (numbered) {
      flushLines();
      if (tasks.length > 0 || bullets.length > 0) flushLists();
      ordered.push({ type: "listItem", content: [paragraph(numbered[1]!)] });
    } else if (line.trim() === "") {
      flushLines();
      flushLists();
    } else if (heading) {
      flushLines();
      flushLists();
      content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineNodes(heading[2]!) });
    } else {
      flushLists();
      lines.push(line.trim());
    }
  }
  flushLines();
  flushLists();
  return { type: "doc", version: 1, content: content.length > 0 ? content : [paragraph("")] };
}
