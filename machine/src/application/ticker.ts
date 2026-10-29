// A minute tick shared by the inboxes and the ticket clocks: things go overdue with no event
// from anywhere to say so, so a clock recomputes what it shows every so often and publishes
// only when something flipped. The timer never keeps the process alive.
export class Ticker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly tick: () => void,
    private readonly everyMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const MINUTE_MS = 60_000;
