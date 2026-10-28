// Socket Mode: Slack's events over a websocket the machine opens with the app-level token, so
// reactions and new messages arrive as they happen without a public URL. Every envelope is
// acknowledged at once by its `envelope_id`; `events_api` payloads are handed to the inbox;
// a close or a `disconnect` reconnects with backoff. Node's global WebSocket, nothing added.
import { z } from "zod";

/** The events the inbox acts on; anything else is dropped. */
export const SocketEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    channel: z.string(),
    ts: z.string(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
    subtype: z.string().optional(),
    thread_ts: z.string().optional(),
  }),
  z.object({
    type: z.enum(["reaction_added", "reaction_removed"]),
    user: z.string(),
    reaction: z.string(),
    item_user: z.string().optional(),
    item: z.object({ type: z.string(), channel: z.string().optional(), ts: z.string().optional() }),
    event_ts: z.string(),
  }),
]);
export type SocketEvent = z.infer<typeof SocketEvent>;

const Envelope = z.object({
  type: z.string(),
  envelope_id: z.string().optional(),
  reason: z.string().optional(),
  payload: z.unknown().optional(),
});

export type SocketState = "connected" | "disconnected";

/** The slice of the WebSocket API this uses; Node's global class and a test fake both fit. */
export interface SocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SocketModeOptions {
  /** `apps.connections.open`: a fresh wss url each time. */
  openSocket: () => Promise<string>;
  onEvent: (event: SocketEvent) => void;
  onState?: (state: SocketState) => void;
  /** Tests pass a fake class. */
  connect?: (url: string) => SocketLike;
  /** Waits between reconnects: 1s, 2s, 4s… capped at 60s. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export class SocketMode {
  state: SocketState = "disconnected";
  private socket: SocketLike | null = null;
  private stopped = false;
  private attempts = 0;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SocketModeOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Connects, and keeps reconnecting until `stop`. Resolves once the first attempt is made. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    this.setState("disconnected");
  }

  private setState(state: SocketState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = await this.options.openSocket();
    } catch (error) {
      console.warn(`slack socket: could not open: ${error instanceof Error ? error.message : String(error)}`);
      void this.reconnect();
      return;
    }
    const connect = this.options.connect ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    const socket = connect(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.setState("connected");
    });
    socket.addEventListener("message", (event) => this.receive(socket, String(event.data ?? "")));
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setState("disconnected");
      void this.reconnect();
    });
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.attempts, backoff.length - 1)] ?? 60_000;
    this.attempts++;
    await this.sleep(delay);
    await this.connect();
  }

  private receive(socket: SocketLike, raw: string): void {
    let parsed: z.infer<typeof Envelope>;
    try {
      parsed = Envelope.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (parsed.envelope_id) socket.send(JSON.stringify({ envelope_id: parsed.envelope_id }));
    if (parsed.type === "hello") {
      this.setState("connected");
      return;
    }
    if (parsed.type === "disconnect") {
      // Slack wants a fresh connection: close this one, the close handler reconnects.
      if (parsed.reason !== "warning") socket.close();
      return;
    }
    if (parsed.type !== "events_api") return;
    const payload = parsed.payload as { event?: unknown } | undefined;
    const event = SocketEvent.safeParse(payload?.event ?? payload);
    if (event.success) this.options.onEvent(event.data);
  }
}
