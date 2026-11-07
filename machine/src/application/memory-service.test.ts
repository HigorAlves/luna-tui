import type { MemoryAnswerContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { type ForgetRecord, MemoryAgentsOffError, MemoryItemNotFoundError, MemoryNoAnswerError, MemoryOffError, MemoryService } from "./memory-service.ts";

const draft = (text: string, over: Record<string, unknown> = {}) => ({
  kind: "outcome" as const,
  repo: "api-1",
  source: { kind: "github" as const, ref: null },
  anchors: { files: ["src/a.ts"], commit: "abc" },
  provenance: { by: "machine" as const, card: "c1", run: null, pack: null },
  trust: "fact" as const,
  text,
  ...over,
});

const setup = async (run?: (c: MemoryAnswerContext) => Promise<{ answer: string; citations: string[]; grounded: boolean }>) => {
  const memory = fakeMemory();
  const [a, b] = await memory.write([draft("the retry loop in the uploader was capped at three attempts"), draft("uploader review asked for a timeout", { repo: "web-2" })]);
  const forgotten: ForgetRecord[] = [];
  const service = new MemoryService({ memory, ...(run ? { run } : {}), slugOf: (p) => `slug-of-${p.split("/").at(-1)}`, onForgotten: async (r) => void forgotten.push(r) });
  return { memory, service, a: a!, b: b!, forgotten };
};

describe("MemoryService", () => {
  it("is 'memory is off' for every read and write when the port is noMemory()", async () => {
    const service = new MemoryService({ memory: noMemory(), slugOf: (p) => p });
    await expect(service.recall({ query: "x" })).rejects.toBeInstanceOf(MemoryOffError);
    await expect(service.ask({ question: "x" })).rejects.toBeInstanceOf(MemoryOffError);
    await expect(service.list({})).rejects.toBeInstanceOf(MemoryOffError);
    expect(await service.status()).toEqual({ enabled: false, mode: null, tokensToday: null, costUsdToday: null, cognifiedToday: 0 });
  });

  it("recalls items for the operator, narrowed to a repository by slug or by checkout path", async () => {
    const { service, a } = await setup();
    expect((await service.recall({ query: "uploader retry" })).items.map((i) => i.id)).toContain(a.id);
    const web = await service.recall({ query: "uploader timeout", repo: "web-2" });
    expect(web.items.map((i) => i.text)).toEqual(["uploader review asked for a timeout"]);
    const byPath = await service.recall({ query: "uploader timeout", repo: "/work/api-1" });
    expect(byPath.items).toEqual([]);
  });

  it("asks the pack with the recalled items as data, and keeps only citations it was given", async () => {
    let seen: MemoryAnswerContext | null = null;
    const { service, a } = await setup(async (context) => {
      seen = context;
      return { answer: "Three attempts.", citations: [context.items[0]!.id, "mem_9999", context.items[0]!.id], grounded: true };
    });
    const out = await service.ask({ question: "how many retries does the uploader do?" });
    expect(seen!.question).toBe("how many retries does the uploader do?");
    expect(seen!.items.map((i) => i.id)).toContain(a.id);
    expect(out).toMatchObject({ via: "pack", answer: "Three attempts.", grounded: true, citations: [{ kind: "item", ref: expect.any(String) }] });
    expect(out.citations).toHaveLength(1);
  });

  it("answers 'nothing' without running a pack when recall found nothing", async () => {
    let ran = 0;
    const { service } = await setup(async () => (ran++, { answer: "", citations: [], grounded: false }));
    const out = await service.ask({ question: "zebra crossing" });
    expect(ran).toBe(0);
    expect(out).toMatchObject({ via: "pack", grounded: false, citations: [] });
  });

  it("is ungrounded when the pack cites nothing real", async () => {
    const { service } = await setup(async () => ({ answer: "Probably three.", citations: ["nope"], grounded: true }));
    expect((await service.ask({ question: "uploader retry attempts" })).grounded).toBe(false);
  });

  it("refuses the pack path with agents off, but still asks Cognee", async () => {
    const { service } = await setup();
    await expect(service.ask({ question: "uploader retry attempts" })).rejects.toBeInstanceOf(MemoryAgentsOffError);
    const out = await service.ask({ question: "uploader retry attempts" }, "cognee");
    expect(out.via).toBe("cognee");
    expect(out.citations[0]).toMatchObject({ kind: "item" });
  });

  it("says so when Cognee gives no answer", async () => {
    const memory = fakeMemory();
    memory.answer = async () => null;
    const service = new MemoryService({ memory, slugOf: (p) => p });
    await expect(service.ask({ question: "x" }, "cognee")).rejects.toBeInstanceOf(MemoryNoAnswerError);
  });

  it("lists with filters and a cap", async () => {
    const { service, a, b } = await setup();
    expect((await service.list({})).map((i) => i.id)).toEqual([a.id, b.id]);
    expect((await service.list({ repo: "web-2" })).map((i) => i.id)).toEqual([b.id]);
    expect(await service.list({ status: ["retired"] })).toEqual([]);
    expect(await service.list({ limit: 1 })).toHaveLength(1);
  });

  it("forgets an item and records the fact, the item as it was, as ground truth", async () => {
    const { service, a, forgotten, memory } = await setup();
    const out = await service.forget(a.id, "board", "wrong");
    expect(out.status).toBe("retired");
    expect(memory.items.find((i) => i.id === a.id)!.status).toBe("retired");
    expect(forgotten).toEqual([{ id: a.id, by: "board", reason: "wrong", at: expect.any(String), item: expect.objectContaining({ text: a.text, status: "active" }) }]);
    await expect(service.forget("mem_9999", "board")).rejects.toBeInstanceOf(MemoryItemNotFoundError);
  });

  it("does not undo a forget when recording it fails", async () => {
    const memory = fakeMemory();
    const [a] = await memory.write([draft("x item")]);
    const service = new MemoryService({ memory, slugOf: (p) => p, onForgotten: async () => Promise.reject(new Error("disk full")) });
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await service.forget(a!.id, "board")).status).toBe("retired");
    } finally {
      console.error = quiet;
    }
  });

  it("adopts only an outside item", async () => {
    const { service, a, memory } = await setup();
    await expect(service.adopt(a.id, "board")).rejects.toBeInstanceOf(MemoryItemNotFoundError);
    memory.items.find((i) => i.id === a.id)!.trust = "outside";
    expect((await service.adopt(a.id, "board")).trust).toBe("lesson");
  });
});
