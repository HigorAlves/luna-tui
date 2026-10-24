// Announces running stage containers on the event stream. The board follows them in herdr
// tabs on the host, so watching works whether the machine runs there or in Docker.
import type { Watcher } from "../../application/ports.ts";
import type { Bus } from "./bus.ts";

export class StreamWatcher implements Watcher {
  constructor(private readonly bus: Bus) {}

  async follow(taskId: string, label: string, cwd: string, container: string): Promise<void> {
    this.bus.publish({ type: "stage.started", taskId, label, cwd, container });
  }

  async close(taskId: string): Promise<void> {
    this.bus.publish({ type: "task.closed", id: taskId });
  }
}
