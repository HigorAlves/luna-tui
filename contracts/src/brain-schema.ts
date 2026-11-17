// Renders omnigraph's schema file from the brain's tables (brain.ts). `brain/schema.pg` is this
// text, written by `pnpm brain:schema`; a test holds the file to it. Pure.
import { BRAIN_EDGES, BRAIN_NODES, type BrainEdgeSpec, type BrainField, type BrainNodeSpec } from "./brain.ts";

const HEADER = `// The company brain's schema (RFC 0010). Generated from contracts/src/brain.ts by
// \`pnpm brain:schema\`: change the tables there, never this file.
//
// A key or a cardinality cannot change once its type exists. The graph is rebuilt from the
// machine's own records, so such a change is a new graph and a rebuild.`;

// A description sits inside a double-quoted string of the schema language, on one line.
const quoted = (text: string): string => {
  if (/["\\\n\r]/.test(text)) throw new Error(`brain schema: ${JSON.stringify(text)} cannot go in a quoted annotation`);
  return `"${text}"`;
};

function typeOf(field: BrainField): string {
  const base = typeof field.type === "object" ? `enum(${field.type.enum.join(", ")})` : field.type;
  return `${base}${field.nullable ? "?" : ""}${field.index ? " @index" : ""}`;
}

function node(name: string, spec: BrainNodeSpec): string {
  const annotations = [`@description(${quoted(spec.description)})`, ...(spec.instruction ? [`@instruction(${quoted(spec.instruction)})`] : [])];
  const fields = [`    slug: String @key`, ...Object.entries(spec.fields).map(([field, value]) => `    ${field}: ${typeOf(value)}`)];
  return [`node ${name}`, ...annotations.map((annotation) => `    ${annotation}`), `{`, ...fields, `}`].join("\n");
}

function edge(name: string, spec: BrainEdgeSpec): string {
  // No annotation means any number, which is what 0 and no maximum say.
  const card = spec.min === 0 && spec.max === null ? "" : ` @card(${spec.min}..${spec.max ?? ""})`;
  return [`edge ${name}: ${spec.from} -> ${spec.to}${card} @description(${quoted(spec.description)}) {`, `    @key(@src, @dst)`, `}`].join("\n");
}

/** The whole schema file: every node type, then every edge, in the tables' order. */
export function renderBrainSchema(): string {
  const nodes = Object.entries(BRAIN_NODES as Record<string, BrainNodeSpec>).map(([name, spec]) => node(name, spec));
  const edges = Object.entries(BRAIN_EDGES as Record<string, BrainEdgeSpec>).map(([name, spec]) => edge(name, spec));
  return `${[HEADER, ...nodes, ...edges].join("\n\n")}\n`;
}
