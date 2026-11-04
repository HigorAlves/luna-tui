// The files a change can reach, read from the code graph: the regression sweep's list. An edge
// points from a dependent to what it imports or calls, so the radius follows edges in reverse
// from the nodes of the changed files. Pure.

type End = string | { id: string };

/** The part of `graphify-out/graph.json` the sweep reads. */
export interface GraphJson {
  nodes?: Array<{ id: string; source_file?: string }>;
  links?: Array<{ source: End; target: End; source_file?: string }>;
}

const MAX_FILES = 60;

const idOf = (end: End): string => (typeof end === "string" ? end : end.id);
const normal = (path: string): string => path.replace(/^(\.\/|\/work\/)/, "");

/** The `source_file`s of the nodes that reach a node of `changed` within `depth` hops, minus `changed`, sorted, at most 60. */
export function blastRadius(graph: GraphJson, changed: string[], depth = 2): string[] {
  const files = new Map<string, string>();
  for (const node of graph.nodes ?? []) if (node.source_file) files.set(node.id, normal(node.source_file));
  const touched = new Set(changed.map(normal));
  const dependents = new Map<string, string[]>();
  for (const link of graph.links ?? []) {
    const target = idOf(link.target);
    dependents.set(target, [...(dependents.get(target) ?? []), idOf(link.source)]);
  }
  let frontier = new Set([...files].filter(([, file]) => touched.has(file)).map(([id]) => id));
  const seen = new Set(frontier);
  const reached = new Set<string>();
  for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const source of dependents.get(id) ?? []) {
        if (seen.has(source)) continue;
        seen.add(source);
        next.add(source);
        const file = files.get(source);
        if (file && !touched.has(file)) reached.add(file);
      }
    }
    frontier = next;
  }
  return [...reached].sort().slice(0, MAX_FILES);
}
