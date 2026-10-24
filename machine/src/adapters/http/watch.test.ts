import type { StreamMessage } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { Bus } from "./bus.ts";
import { StreamWatcher } from "./watch.ts";

function listen(bus: Bus): StreamMessage[] {
  const seen: StreamMessage[] = [];
  bus.subscribe((message) => seen.push(message));
  return seen;
}

describe("StreamWatcher", () => {
  it("announces a started stage container, so a board on the host can follow it", async () => {
    const bus = new Bus();
    const seen = listen(bus);
    await new StreamWatcher(bus).follow("t1", "#t1 Fix it", "/wt/repo/fix", "hardness-t1-triage");
    expect(seen).toEqual([
      { type: "stage.started", taskId: "t1", label: "#t1 Fix it", cwd: "/wt/repo/fix", container: "hardness-t1-triage" },
    ]);
  });

  it("announces a closed task, so its watch tab can go", async () => {
    const bus = new Bus();
    const seen = listen(bus);
    await new StreamWatcher(bus).close("t1");
    expect(seen).toEqual([{ type: "task.closed", id: "t1" }]);
  });
});
