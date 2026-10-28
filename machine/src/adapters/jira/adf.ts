// Atlassian Document Format, both ways. Jira stores descriptions and comments as ADF (a JSON
// tree); the machine thinks in markdown. Reading: paragraphs, headings, lists, code blocks,
// links and cards, bold and code marks; anything else is reduced to its text. Writing: what
// the machine says in a comment, paragraphs separated by blank lines, `- ` bullets, and bare
// urls as links. Pure.

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

/** Text with bare urls as link marks. */
function inlineNodes(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let at = 0;
  for (const match of line.matchAll(URL)) {
    const start = match.index;
    if (start > at) nodes.push({ type: "text", text: line.slice(at, start) });
    nodes.push({ type: "text", text: match[0], marks: [{ type: "link", attrs: { href: match[0] } }] });
    at = start + match[0].length;
  }
  if (at < line.length) nodes.push({ type: "text", text: line.slice(at) });
  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

const paragraph = (line: string): AdfNode => ({ type: "paragraph", content: inlineNodes(line) });

/** The document for a plain text: blank lines split paragraphs, consecutive `- ` lines form a bullet list, bare urls link. */
export function markdownToAdf(text: string): AdfDoc {
  const content: AdfNode[] = [];
  let bullets: AdfNode[] = [];
  let lines: string[] = [];
  const flushBullets = () => {
    if (bullets.length > 0) content.push({ type: "bulletList", content: bullets });
    bullets = [];
  };
  const flushLines = () => {
    if (lines.length > 0) content.push(paragraph(lines.join(" ")));
    lines = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (bullet) {
      flushLines();
      bullets.push({ type: "listItem", content: [paragraph(bullet[1]!)] });
    } else if (line.trim() === "") {
      flushLines();
      flushBullets();
    } else if (heading) {
      flushLines();
      flushBullets();
      content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineNodes(heading[2]!) });
    } else {
      flushBullets();
      lines.push(line.trim());
    }
  }
  flushLines();
  flushBullets();
  return { type: "doc", version: 1, content: content.length > 0 ? content : [paragraph("")] };
}
