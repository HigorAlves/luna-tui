// Where a card's design is (RFC 0013, phase 2): Figma links in the card's text and its attachments' URLs, else the repo's `design.figma`, and for an
// on-demand run the link it was given first. Only figma.com and its www host count; node ids are turned into the API's form and checked. Pure.
import { type DesignContext, type DesignRef, type DesignSettings, FIGMA_FILE_KEY, figmaNodeId } from "@hardness/contracts";

const LINK = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,64})(?:\/[^\s?#)"'<>]*)?(?:\?([^\s#)"'<>]*))?/g;
const MAX_FILES = 5;
const MAX_NODES = 20;

/** The Figma references in a text, one per file (in first-seen order), with the node ids of every link to it. */
export function figmaRefsIn(text: string, from: DesignRef["from"]): DesignRef[] {
  const byFile = new Map<string, Set<string>>();
  for (const match of text.matchAll(LINK)) {
    const [, key, query] = match;
    // The host must end at the slash: `figma.com.evil.dev` never reaches `/design/`, and a word before the host is refused by the scheme.
    if (!key || !FIGMA_FILE_KEY.test(key)) continue;
    if (!byFile.has(key)) {
      if (byFile.size >= MAX_FILES) continue;
      byFile.set(key, new Set());
    }
    const node = query ? new URLSearchParams(query).get("node-id") : null;
    const id = node ? figmaNodeId(node) : null;
    if (id && byFile.get(key)!.size < MAX_NODES) byFile.get(key)!.add(id);
  }
  return [...byFile].map(([fileKey, nodes]) => ({ fileKey, nodeIds: [...nodes], page: null, from }));
}

export function designRefOf(input: { link?: string; text: string; attachments: readonly { url: string }[]; settings: DesignSettings }): DesignContext | null {
  if (input.settings.off) return null;
  const found = [
    ...(input.link ? figmaRefsIn(input.link, "link") : []),
    ...figmaRefsIn(input.text, "issue"),
    ...input.attachments.flatMap((a) => figmaRefsIn(a.url, "attachment")),
  ];
  const refs: DesignRef[] = [];
  for (const ref of found) {
    // The same file named by two sources is one reference: its first origin, the node ids of all.
    const same = refs.find((r) => r.fileKey === ref.fileKey);
    if (same) same.nodeIds = [...new Set([...same.nodeIds, ...ref.nodeIds])].slice(0, MAX_NODES);
    else if (refs.length < MAX_FILES) refs.push(ref);
  }
  if (refs.length > 0) return { refs };
  const fallback = input.settings.figma;
  return fallback ? { refs: [{ fileKey: fallback.file, nodeIds: [], page: fallback.page, from: "luna.yaml" }] } : null;
}
