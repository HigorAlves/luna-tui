import { describe, expect, it } from "vitest";

import { type SocketEvent, type SocketLike, SocketMode } from "./socket-mode.ts";

type Listener = (event: { data?: unknown }) => void;

/** A websocket the test drives by hand. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.fire("close");
  }
  fire(type: string, data?: unknown): void {
    for (const l of this.listeners[type] ?? []) l({ data });
  }
  message(payload: unknown): void {
    this.fire("message", JSON.stringify(payload));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const events: SocketEvent[] = [];
  const states: string[] = [];
  const slept: number[] = [];
  let urls = 0;
  const mode = new SocketMode({
    openSocket: async () => `wss://s/${++urls}`,
    onEvent: (e) => void events.push(e),
    onState: (s) => void states.push(s),
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    backoffMs: [10, 20],
    sleep: async (ms) => void slept.push(ms),
  });
  return { mode, sockets, events, states, slept };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SocketMode", () => {
  it("connects, says hello, acks every envelope and surfaces message and reaction events", async () => {
    const { mode, sockets, events, states } = setup();
    await mode.start();
    const socket = sockets[0]!;
    expect(mode.state).toBe("disconnected");
    socket.fire("open");
    socket.message({ type: "hello", connection_info: { app_id: "A1" } });
    expect(mode.state).toBe("connected");
    socket.message({
      type: "events_api",
      envelope_id: "e1",
      payload: { type: "event_callback", event: { type: "message", channel: "C1", ts: "1.0", user: "U2", text: "hi <@U1>", thread_ts: "0.5" } },
    });
    socket.message({
      type: "events_api",
      envelope_id: "e2",
      payload: { event: { type: "reaction_added", user: "U2", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: "0.9" }, event_ts: "1.1" } },
    });
    socket.message({
      type: "events_api",
      envelope_id: "e2b",
      payload: { event: { type: "message", subtype: "message_changed", channel: "C1", ts: "1.2", message: { ts: "1.0", text: "hi <@U1> (edited)", user: "U2" }, previous_message: { ts: "1.0", text: "hi <@U1>" } } },
    });
    socket.message({ type: "events_api", envelope_id: "e2c", payload: { event: { type: "message", subtype: "message_deleted", ts: "1.3", deleted_ts: "1.0", previous_message: { channel: "C1", ts: "1.0" } } } });
    socket.message({ type: "events_api", envelope_id: "e3", payload: { event: { type: "app_home_opened", user: "U1" } } });
    socket.message({ type: "slash_commands", envelope_id: "e4", payload: {} });
    socket.fire("message", "not json");
    expect(socket.sent).toEqual(['{"envelope_id":"e1"}', '{"envelope_id":"e2"}', '{"envelope_id":"e2b"}', '{"envelope_id":"e2c"}', '{"envelope_id":"e3"}', '{"envelope_id":"e4"}']);
    expect(events).toEqual([
      { type: "message", channel: "C1", ts: "1.0", user: "U2", text: "hi <@U1>", thread_ts: "0.5" },
      { type: "reaction_added", user: "U2", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: "0.9" }, event_ts: "1.1" },
      { type: "message", subtype: "message_changed", channel: "C1", ts: "1.2", message: { ts: "1.0", text: "hi <@U1> (edited)", user: "U2" }, previous_message: { ts: "1.0", text: "hi <@U1>" } },
      { type: "message", subtype: "message_deleted", ts: "1.3", deleted_ts: "1.0", previous_message: { channel: "C1", ts: "1.0" } },
    ]);
    expect(states).toEqual(["connected"]);
  });

  it("reconnects with backoff after a close or a disconnect, and stops cleanly", async () => {
    const { mode, sockets, states, slept } = setup();
    await mode.start();
    sockets[0]!.fire("open");
    sockets[0]!.fire("close");
    await tick();
    expect(states).toEqual(["connected", "disconnected"]);
    expect(slept).toEqual([10]);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe("wss://s/2");
    // A warning is only a warning; refresh_requested closes and reconnects.
    sockets[1]!.fire("open");
    sockets[1]!.message({ type: "disconnect", reason: "warning" });
    expect(sockets[1]!.closed).toBe(false);
    sockets[1]!.message({ type: "disconnect", reason: "refresh_requested" });
    await tick();
    expect(sockets[1]!.closed).toBe(true);
    expect(sockets).toHaveLength(3);
    expect(slept).toEqual([10, 10]);
    // Without an open in between the backoff grows, and is capped at the last step.
    sockets[2]!.fire("close");
    await tick();
    sockets[3]!.fire("close");
    await tick();
    expect(slept).toEqual([10, 10, 20, 20]);
    mode.stop();
    expect(sockets[4]!.closed).toBe(true);
    await tick();
    expect(sockets).toHaveLength(5);
    expect(mode.state).toBe("disconnected");
  });

  it("retries when the socket url cannot be fetched", async () => {
    const slept: number[] = [];
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const mode = new SocketMode({
      openSocket: async () => {
        if (++calls === 1) throw new Error("invalid_auth");
        return "wss://ok";
      },
      onEvent: () => {},
      connect: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      backoffMs: [5],
      sleep: async (ms) => void slept.push(ms),
    });
    await mode.start();
    await tick();
    expect(slept).toEqual([5]);
    expect(sockets.map((s) => s.url)).toEqual(["wss://ok"]);
  });
});
