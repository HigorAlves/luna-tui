// `GET /events?since=&source=`: what a client missed is replayed from Postgres, compacted and in
// sequence order, then the stream goes on live with nothing lost or sent twice.
import type { StreamMessage } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { toEvent, toTask } from "./serialize.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
let bus: Bus;
const open: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks, task_tombstones cascade");
  stubs.reset();
  bus = new Bus();
  // As main.ts does: a created or moved task is published whole.
  pipeline = new Pipeline(db, stubs.runnerFor, {
    inline: true,
    hasConfig: () => true,
    onEvent: (event) => {
      if (event.kind !== "transition" && event.kind !== "task.created") return;
      void pipeline.get(event.taskId).then((task) => bus.publish({ type: "task.updated", task: toTask(task), seq: Number(task.seq) }));
    },
  });
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

const app = () => createApp({ db, pipeline, bus });
const notch = { kind: "notch" as const, ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000" };
const newTask = (title: string, source: typeof notch | null = null) => pipeline.createTask({ title, source });
const rename = async (id: string, title: string) =>
  app().request(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ title }), headers: { "content-type": "application/json" } });
const seqOf = async (id: string) => Number((await pipeline.get(id)).seq);

type Message = { event: string } & Partial<StreamMessage> & Record<string, unknown>;

/** Opens the stream and collects every message it sends until the test ends. */
function listen(path: string): Message[] {
  const messages: Message[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const reading = (async () => {
    const response = await app().request(path);
    if (!response.body) throw new Error(`no stream: ${response.status}`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        messages.push({ ...(JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}") as object), event });
      }
    }
  })().catch(() => {});
  open.push(async () => {
    await reader?.cancel().catch(() => {});
    await reading;
  });
  return messages;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The task snapshots and tombstones a stream sent, as the task's title and `deleted:<id>`. */
const changes = (messages: Message[]) =>
  messages.filter((m) => m.event === "task.updated" || m.event === "task.deleted").map((m) => (m.event === "task.deleted" ? `deleted:${m.id}` : `${(m.task as { title: string }).title}`));
const ready = (messages: Message[]) => messages.some((m) => m.event === "ready");

describe("seq on the stream", () => {
  it("is on every task.updated and task.deleted, and on the task itself", async () => {
    const task = await newTask("a");
    const messages = listen("/events");
    await until(() => ready(messages), "ready");
    await rename(task.id, "a2");
    await app().request(`/tasks/${task.id}`, { method: "DELETE" });
    await until(() => messages.some((m) => m.event === "task.deleted"), "the delete");
    const updated = messages.find((m) => m.event === "task.updated")!;
    const deleted = messages.find((m) => m.event === "task.deleted")!;
    expect(updated.seq).toBe((updated.task as { seq: number }).seq);
    expect(deleted.seq).toBeGreaterThan(updated.seq as number);
  });
});

describe("GET /events?since=", () => {
  it("replays the tasks changed after since, each once as it is now, in seq order, then says ready", async () => {
    const a = await newTask("a");
    await newTask("b");
    const c = await newTask("c");
    const since = await seqOf(c.id);
    await rename(a.id, "a2");
    await newTask("d");
    await rename(a.id, "a3");
    const messages = listen(`/events?since=${since}`);
    await until(() => ready(messages), "ready");
    expect(changes(messages)).toEqual(["d", "a3"]);
    const seqs = messages.filter((m) => m.event === "task.updated").map((m) => m.seq as number);
    expect(seqs[0]).toBeGreaterThan(since);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    expect(messages.findIndex((m) => m.event === "ready")).toBe(2);
  });

  it("replays a task deleted after since as task.deleted, and not one deleted before", async () => {
    const x = await newTask("x");
    const y = await newTask("y");
    await pipeline.delete(x.id);
    const since = await pipeline.lastSeq();
    await newTask("z");
    await pipeline.delete(y.id);
    const messages = listen(`/events?since=${since}`);
    await until(() => ready(messages), "ready");
    expect(changes(messages)).toEqual(["z", `deleted:${y.id}`]);
  });

  it("reads it all from Postgres, so a new machine replays the same", async () => {
    await newTask("a");
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
    const messages = listen("/events?since=0");
    await until(() => ready(messages), "ready");
    expect(changes(messages)).toEqual(["a"]);
  });

  it("goes on live after the replay, every change once and in order", async () => {
    const a = await newTask("a");
    const b = await newTask("b");
    const messages = listen(`/events?since=${await seqOf(b.id)}`);
    await until(() => ready(messages), "ready");
    await rename(a.id, "a2");
    await rename(b.id, "b2");
    await rename(a.id, "a3");
    await until(() => changes(messages).at(-1) === "a3", "the last rename");
    const sent = messages.filter((m) => m.event === "task.updated").map((m) => m.seq as number);
    expect(sent).toEqual([...new Set(sent)].sort((x, y) => x - y));
    expect(changes(messages)).toContain("b2");
  });

  it("still sends a change that commits while the replay query runs, once", async () => {
    const a = await newTask("a");
    const b = await newTask("b");
    const real = pipeline.changesSince.bind(pipeline);
    vi.spyOn(pipeline, "changesSince").mockImplementationOnce(async (since, kind) => {
      const before = await real(since, kind);
      await rename(b.id, "b2"); // committed and published after the query read
      return before;
    });
    const messages = listen(`/events?since=${await seqOf(a.id)}`);
    await until(() => changes(messages).includes("b2"), "the rename");
    await rename(a.id, "a2");
    await until(() => changes(messages).includes("a2"), "a later change");
    expect(changes(messages)).toEqual(["b", "b2", "a2"]);
  });

  it("does not send twice a change that commits after the subscription but before the replay query", async () => {
    const a = await newTask("a");
    const b = await newTask("b");
    const real = pipeline.changesSince.bind(pipeline);
    vi.spyOn(pipeline, "changesSince").mockImplementationOnce(async (since, kind) => {
      await rename(b.id, "b2"); // published while subscribed, and read by the query below
      return real(since, kind);
    });
    const messages = listen(`/events?since=${await seqOf(a.id)}`);
    await until(() => ready(messages), "ready");
    await rename(a.id, "a2");
    await until(() => changes(messages).includes("a2"), "a later change");
    expect(changes(messages)).toEqual(["b2", "a2"]);
  });

  it("with source=notch replays and streams only the notch tasks", async () => {
    const n = await newTask("n", notch);
    const p = await newTask("p");
    const messages = listen("/events?since=0&source=notch");
    await until(() => ready(messages), "ready");
    expect(changes(messages)).toEqual(["n"]);
    await rename(p.id, "p2");
    await app().request(`/tasks/${p.id}`, { method: "DELETE" });
    await rename(n.id, "n2");
    await until(() => changes(messages).includes("n2"), "the notch change");
    expect(changes(messages)).toEqual(["n", "n2"]);
  });

  it("with only source=notch streams from now on", async () => {
    await newTask("old", notch);
    const messages = listen("/events?source=notch");
    await until(() => ready(messages), "ready");
    await newTask("new", notch);
    await until(() => changes(messages).includes("new"), "the new task");
    expect(changes(messages)).toEqual(["new"]);
  });

  /** What main.ts publishes for a stage starting on a task: an activity entry and the watch tab's cue. */
  const stageStarts = async (id: string) => {
    const created = (await pipeline.events(id)).find((e) => e.kind === "task.created")!;
    bus.publish({ type: "task.event", event: toEvent(created) });
    bus.publish({ type: "stage.started", taskId: id, label: `#${id.slice(0, 8)}`, cwd: "/wt", container: `c-${id}` });
  };
  it("with source=notch passes a new notch task's first events, before the stream has sent its snapshot", async () => {
    const messages = listen(`/events?since=${await pipeline.lastSeq()}&source=notch`);
    await until(() => ready(messages), "ready");
    const n = await newTask("n", notch);
    // main.ts publishes task.created's activity entry at once, the task snapshot only after a read.
    await stageStarts(n.id);
    await until(() => messages.some((m) => m.event === "stage.started" && m.taskId === n.id), "the stage start");
    expect(messages.filter((m) => m.event === "task.event")).toHaveLength(1);
  });

  it("with source=notch passes the live stage events of a notch task unchanged since the client's cursor", async () => {
    const n = await newTask("n", notch);
    const messages = listen(`/events?since=${await seqOf(n.id)}&source=notch`);
    await until(() => ready(messages), "ready");
    await stageStarts(n.id);
    await until(() => messages.some((m) => m.event === "stage.started" && m.taskId === n.id), "the stage start");
    expect(changes(messages)).toEqual([]);
  });

  it("with source=notch never passes a board task's events", async () => {
    const p = await newTask("p");
    const n = await newTask("n", notch);
    const messages = listen("/events?since=0&source=notch");
    await until(() => ready(messages), "ready");
    await stageStarts(p.id);
    bus.publish({ type: "task.closed", id: p.id });
    await stageStarts(n.id);
    await until(() => messages.some((m) => m.event === "stage.started" && m.taskId === n.id), "the notch stage start");
    expect(messages.filter((m) => m.event === "stage.started").map((m) => m.taskId)).toEqual([n.id]);
    expect(messages.some((m) => m.event === "task.closed")).toBe(false);
    expect(messages.filter((m) => m.event === "task.event")).toHaveLength(1);
  });

  it("with source=notch passes task.shipped for a notch task and never for a board task's", async () => {
    const p = await newTask("p");
    const n = await newTask("n", notch);
    const messages = listen("/events?since=0&source=notch");
    await until(() => ready(messages), "ready");
    const shipped = (id: string) => ({ type: "task.shipped" as const, shipped: { id, title: "t", prUrl: "u", number: 1, mergedSha: null, format: null, howToVerify: null, media: [], at: "t" } });
    bus.publish(shipped(p.id));
    bus.publish(shipped(n.id));
    await until(() => messages.some((m) => m.event === "task.shipped"), "the notch task's shipped");
    expect(messages.filter((m) => m.event === "task.shipped").map((m) => (m as unknown as { shipped: { id: string } }).shipped.id)).toEqual([n.id]);
  });

  it("is 400 for a since that is not a sequence number or an unknown source", async () => {
    expect((await app().request("/events?since=-1")).status).toBe(400);
    expect((await app().request("/events?since=abc")).status).toBe(400);
    expect((await app().request("/events?source=fax")).status).toBe(400);
  });
});
