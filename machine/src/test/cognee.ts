// A Cognee in memory for tests of the Memory implementation: the same client interface, the shapes the spike recorded (a data id per item
// in order, chunks that carry their `luna_id`, a dataset with no graph yet answering an error), word overlap for scoring in place of
// embeddings, and switches to make it fail.
import { randomUUID } from "node:crypto";

import { CogneeError, type CogneeAddItem, type CogneeClient, type CogneeDataItem, type CogneeSearchEntry, md5 } from "../adapters/cognee/client.ts";

interface Stored {
  dataId: string;
  name: string;
  text: string;
  lunaId: string;
  hash: string;
}

export interface FakeCognee extends CogneeClient {
  down: boolean;
  /** Fail the next `n` adds. */
  failAdds: number;
  cost: () => Promise<unknown | null>;
  readonly calls: { add: Array<{ dataset: string; items: CogneeAddItem[] }>; cognify: string[][]; search: Array<{ datasets: string[]; query: string }>; deleted: string[]; code: Array<{ dataset: string; operation: string }> };
  readonly store: Map<string, { id: string; items: Stored[] }>;
  /** Puts an item in a dataset the way the Cognee UI would: no luna_id. */
  uploadOutside(dataset: string, name: string, text: string): string;
  /** Removes an item behind the machine's back. */
  removeOutside(dataset: string, dataId: string): void;
  codeAnswer: unknown;
  completion: string | null;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

export function fakeCognee(): FakeCognee {
  const store = new Map<string, { id: string; items: Stored[] }>();
  const calls: FakeCognee["calls"] = { add: [], cognify: [], search: [], deleted: [], code: [] };
  const dataset = (name: string): { id: string; items: Stored[] } => {
    let found = store.get(name);
    if (!found) store.set(name, (found = { id: randomUUID(), items: [] }));
    return found;
  };
  const up = (): void => {
    if (fake.down) throw new CogneeError("cognee is down", null);
  };
  const fake: FakeCognee = {
    down: false,
    failAdds: 0,
    cost: async () => null,
    calls,
    store,
    codeAnswer: [{ symbol: "main", file: "src/main.ts" }],
    completion: "An answer.",
    async connect() {
      up();
    },
    async health() {
      return !fake.down;
    },
    async add({ dataset: name, items }) {
      up();
      calls.add.push({ dataset: name, items });
      if (fake.failAdds > 0) {
        fake.failAdds--;
        throw new CogneeError("cognee POST /api/v1/add answered 500", 500);
      }
      const target = dataset(name);
      const dataIds = items.map((item) => {
        const text = item.text ?? item.file?.content.toString("utf8") ?? "";
        const stored: Stored = { dataId: randomUUID(), name: item.file?.name ?? `text_${md5(text)}`, text, lunaId: item.lunaId, hash: md5(item.file?.content ?? text) };
        target.items.push(stored);
        return stored.dataId;
      });
      return { datasetId: target.id, datasetName: name, dataIds };
    },
    async cognify(datasets) {
      up();
      calls.cognify.push(datasets);
    },
    async chunks({ datasets, query, topK }) {
      up();
      calls.search.push({ datasets, query });
      for (const name of datasets) if (!store.has(name)) throw new CogneeError(`Dataset(s) not found: '${name}'`, 404);
      const q = words(query);
      return datasets.map((name): CogneeSearchEntry => {
        const target = dataset(name);
        const hits = target.items
          .map((item) => ({ item, overlap: [...words(item.text)].filter((w) => q.has(w)).length }))
          .filter((x) => x.overlap > 0)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, topK)
          .map(({ item, overlap }) => ({ score: Math.min(1, overlap / 5), text: item.text, dataId: item.dataId, lunaId: item.lunaId.startsWith("outside:") ? null : item.lunaId }));
        return { datasetId: target.id, datasetName: name, error: target.items.length === 0 ? "no graph yet" : null, hits };
      });
    },
    async code({ dataset: name, operation }) {
      up();
      calls.code.push({ dataset: name, operation });
      return [{ datasetName: name, error: null, results: fake.codeAnswer }];
    },
    async complete({ datasets }) {
      up();
      void datasets;
      return fake.completion;
    },
    async datasets() {
      up();
      return [...store.entries()].map(([name, d]) => ({ id: d.id, name }));
    },
    async data(datasetId) {
      up();
      const target = [...store.values()].find((d) => d.id === datasetId);
      return (target?.items ?? []).map((i): CogneeDataItem => ({ id: i.dataId, name: i.name, lunaId: i.lunaId.startsWith("outside:") ? null : i.lunaId, contentHash: i.hash }));
    },
    async deleteData(datasetId, dataId) {
      up();
      const target = [...store.values()].find((d) => d.id === datasetId);
      if (target) target.items = target.items.filter((i) => i.dataId !== dataId);
      calls.deleted.push(dataId);
    },
    uploadOutside(name, itemName, text) {
      const stored: Stored = { dataId: randomUUID(), name: itemName, text, lunaId: `outside:${randomUUID()}`, hash: md5(text) };
      dataset(name).items.push(stored);
      return stored.dataId;
    },
    removeOutside(name, dataId) {
      const target = dataset(name);
      target.items = target.items.filter((i) => i.dataId !== dataId);
    },
  };
  return fake;
}
