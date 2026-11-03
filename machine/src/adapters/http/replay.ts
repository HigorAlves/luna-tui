// `GET /events?since=<seq>&source=<kind>`: a stream whose task snapshots come from Postgres in
// sequence order, never straight off the bus. A task message on the bus is only a poke: when its
// `seq` is past the stream's cursor, the stream reads every change after the cursor and sends
// them, compacted (a task changed three times is sent once, as it is now). The stream subscribes
// before its first read, so a change committed while that read runs pokes it again, and the
// sequence is handed out in commit order (the `tasks_seq` trigger), so a read never skips a
// number it would later find. Messages that are not task snapshots pass as they come; with a
// source, the ones about one task (`task.event`, `stage.started`, `task.closed`, `budget.alert`)
// pass only for a task of that source, looked up once and kept: from the snapshots the bus and
// the replay carry, else from Postgres, and forgotten when the task is deleted. A task's source
// never changes after it is made (PATCH refuses it), so what is kept stays true. Those messages
// go out in the order they came, a lookup holding back the ones behind it.
import type { StreamMessage, Task } from "@hardness/contracts";

import type { TaskChange } from "../../application/task-store.ts";
import type { TaskRow } from "../../domain/task.ts";

export interface ReplayDeps {
  changesSince(since: number, sourceKind: string | null): Promise<TaskChange[]>;
  lastSeq(): Promise<number>;
  serialize(row: TaskRow): Promise<Task>;
  /** The task's `source.kind`, null for a task with none or one that is gone. */
  sourceOf(taskId: string): Promise<string | null>;
  /** Sends one message; never rejects. */
  write(message: StreamMessage): Promise<void>;
}

/** The task a message is about, if it is about one. */
function taskOf(message: StreamMessage): string | null {
  switch (message.type) {
    case "task.event":
      return message.event.taskId;
    case "stage.started":
      return message.taskId;
    case "task.closed":
      return message.id;
    case "budget.alert":
      return message.alert.taskId;
    default:
      return null;
  }
}

export class ReplayFeed {
  /** The last sequence number sent; null until a stream with no `since` reads where now is. */
  private cursor: number | null;
  private reading: Promise<void> | null = null;
  private again = false;
  /** Each task's source kind, as far as this stream has needed to know. */
  private readonly kinds = new Map<string, string | null>();
  /** The per-task messages waiting on a lookup, so they leave in order. */
  private passing: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: ReplayDeps,
    since: number | null,
    private readonly sourceKind: string | null,
  ) {
    this.cursor = since;
  }

  /** One message off the bus. */
  offer(message: StreamMessage): void {
    if (message.type === "task.updated" || message.type === "task.deleted") {
      if (message.type === "task.updated") this.kinds.set(message.task.id, message.task.source?.kind ?? null);
      else this.kinds.delete(message.id);
      if (this.cursor === null || message.seq > this.cursor) this.read().catch((error: unknown) => console.error("event replay read failed", error));
      return;
    }
    const id = taskOf(message);
    if (this.sourceKind === null || id === null) {
      void this.deps.write(message);
      return;
    }
    this.passing = this.passing
      .then(async () => {
        if ((await this.kindOf(id)) === this.sourceKind) await this.deps.write(message);
      })
      .catch((error: unknown) => console.error("event source lookup failed", error));
  }

  private async kindOf(id: string): Promise<string | null> {
    if (!this.kinds.has(id)) this.kinds.set(id, await this.deps.sourceOf(id));
    return this.kinds.get(id) ?? null;
  }

  /** Sends every change past the cursor; a poke while it reads makes it read again. Resolves once caught up. */
  read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      // Cleared in the same turn as the last `again` check, so no poke falls between the two.
      try {
        let cursor = this.cursor ?? (await this.deps.lastSeq());
        this.cursor = cursor;
        do {
          this.again = false;
          for (const change of await this.deps.changesSince(cursor, this.sourceKind)) {
            if ("task" in change) {
              this.kinds.set(change.task.id, change.task.source?.kind ?? null);
              await this.deps.write({ type: "task.updated", task: await this.deps.serialize(change.task), seq: change.seq });
            } else {
              this.kinds.delete(change.deleted);
              await this.deps.write({ type: "task.deleted", id: change.deleted, seq: change.seq });
            }
            this.cursor = cursor = change.seq;
          }
        } while (this.again);
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }
}
