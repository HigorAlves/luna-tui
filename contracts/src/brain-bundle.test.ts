import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRAIN_QUERIES, renderBrainSchema } from "./index.ts";

// The cluster the brain service boots from (RFC 0010): brain/ at the repository's root.
const bundle = (path: string): string => readFileSync(fileURLToPath(new URL(`../../brain/${path}`, import.meta.url)), "utf8");

interface StoredQuery {
  name: string;
  file: string;
  params: Record<string, string>;
  description: string;
  body: string;
}

function storedQueries(): StoredQuery[] {
  const files = readdirSync(fileURLToPath(new URL("../../brain/queries/", import.meta.url))).filter((name) => name.endsWith(".gq")).sort();
  return files.flatMap((file) => {
    const text = bundle(`queries/${file}`);
    return [...text.matchAll(/^query (\w+)\(([^)]*)\) @description\("([^"]*)"\) \{\n([\s\S]*?)\n\}/gm)].map(([, name, params, description, body]) => ({
      name: name!,
      file,
      params: Object.fromEntries(
        params!
          .split(",")
          .map((param) => param.trim())
          .filter(Boolean)
          .map((param) => {
            const [key, type] = param.split(":").map((part) => part.trim());
            return [key!.replace(/^\$/, ""), type!];
          }),
      ),
      description: description!,
      body: body!,
    }));
  });
}

describe("brain/schema.pg", () => {
  it("is what the brain's tables render: run `pnpm brain:schema` after changing contracts/src/brain.ts", () => {
    expect(bundle("schema.pg")).toBe(renderBrainSchema());
  });

  it("gives every type a key and a description", () => {
    const schema = renderBrainSchema();
    const nodes = schema.split(/\n(?=node )/).slice(1);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node).toMatch(/@description\("[^"]+"\)/);
      expect(node).toMatch(/slug: String @key/);
    }
    for (const edge of schema.match(/^edge .*$/gm) ?? []) expect(edge).toMatch(/@description\("[^"]+"\)/);
  });
});

describe("brain/queries", () => {
  it("holds exactly the queries the contracts list, with the same parameters and descriptions", () => {
    const stored = storedQueries();
    // every `query` in the files was read: a query the pattern missed would run on the server and be unknown here
    const declared = readdirSync(fileURLToPath(new URL("../../brain/queries/", import.meta.url))).reduce((n, file) => n + (bundle(`queries/${file}`).match(/^query /gm)?.length ?? 0), 0);
    expect(stored).toHaveLength(declared);
    expect(stored.map((q) => q.name).sort()).toEqual(BRAIN_QUERIES.map((q) => q.name).sort());
    for (const listed of BRAIN_QUERIES) {
      const query = stored.find((q) => q.name === listed.name)!;
      expect(query.params, listed.name).toEqual(listed.params);
      expect(query.description, listed.name).toBe(listed.description);
    }
  });

  it("keeps the hygiene queries in hygiene.gq and nothing else there", () => {
    const stored = storedQueries();
    const hygiene = BRAIN_QUERIES.filter((q) => q.hygiene).map((q) => q.name).sort();
    expect(stored.filter((q) => q.file === "hygiene.gq").map((q) => q.name).sort()).toEqual(hygiene);
  });

  it("has no stored write: the machine writes by loading rows", () => {
    for (const query of storedQueries()) expect(query.body, query.name).not.toMatch(/^\s*(insert|update|delete)\b/m);
  });

  it("matches a repository tool query on the repository its parameter names", () => {
    for (const listed of BRAIN_QUERIES.filter((q) => q.tool === "repo")) {
      expect(storedQueries().find((q) => q.name === listed.name)!.body, listed.name).toMatch(/\$r: Repo \{ slug: \$repo \}/);
    }
  });

  it("caps every list an agent may read", () => {
    const agent = new Set(BRAIN_QUERIES.filter((q) => q.agent).map((q) => q.name));
    for (const query of storedQueries().filter((q) => agent.has(q.name) && q.name !== "card_lookup")) expect(query.body, query.name).toMatch(/^\s*limit \d+$/m);
  });
});

describe("brain/policies and cluster.yaml", () => {
  const group = (text: string, name: string): string[] => (text.match(new RegExp(`^  ${name}: \\[([^\\]]*)\\]`, "m"))?.[1] ?? "").split(",").map((actor) => actor.trim()).filter(Boolean);

  it("lets the reader read and never write", () => {
    const policy = bundle("policies/graph.policy.yaml");
    expect(group(policy, "readers").sort()).toEqual(["luna-facts", "luna-memories", "luna-reader", "owner"]);
    expect(group(policy, "writers").sort()).toEqual(["luna-facts", "luna-memories", "owner"]);
    expect(group(policy, "admins")).toEqual(["owner"]);
    // `change` and `schema_apply` are granted to the writers and the admins alone
    expect(policy.match(/actions: \[change\]/g)).toHaveLength(1);
    expect(policy).toMatch(/actors: \{ group: writers \}\n\s+actions: \[change\]/);
    expect(policy).toMatch(/actors: \{ group: admins \}\n\s+actions: \[schema_apply\]/);
  });

  it("serves one graph, `brain`, from the schema and the queries beside it", () => {
    const cluster = bundle("cluster.yaml");
    expect(cluster).toMatch(/^graphs:\n  brain:\n    schema: schema\.pg\n    queries: queries\//m);
    expect(cluster).toMatch(/applies_to: \[brain\]/);
  });
});

describe("the brain service in compose.yaml", () => {
  const compose = readFileSync(fileURLToPath(new URL("../../compose.yaml", import.meta.url)), "utf8");
  const service = /\n  brain:\n([\s\S]*?)\n\n/.exec(compose)?.[1] ?? "";

  it("is opt-in, pinned by digest and bound to localhost", () => {
    expect(service).toMatch(/profiles: \["brain"\]/);
    expect(service).toMatch(/image: modernrelay\/omnigraph-server@sha256:[0-9a-f]{64}\n/);
    const ports = service.match(/^      - "[^"]*:8080"$/gm) ?? [];
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatch(/"127\.0\.0\.1:/);
  });

  it("starts through boot.sh, with a memory limit and a restart", () => {
    expect(service).toMatch(/entrypoint: \["\/bin\/sh", "\/config\/boot\.sh"\]/);
    expect(service).toMatch(/mem_limit:/);
    expect(service).toMatch(/restart: unless-stopped/);
    expect(service).toMatch(/RUST_MIN_STACK: "8388608"/);
  });

  // Embedding is the one outbound call omnigraph makes, and only with a key (RFC 0010): every model call here is a pack.
  it("holds no embedding setting and no provider key, so the server calls nothing outside", () => {
    expect(service).not.toMatch(/OMNIGRAPH_EMBED|OPENROUTER|OPENAI|GEMINI|ANTHROPIC/);
  });
});

