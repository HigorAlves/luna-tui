// Fans pipeline updates out to every open `GET /events` stream.
import type { StreamMessage } from "@hardness/contracts";

export type Listener = (message: StreamMessage) => void;

export class Bus {
  private readonly listeners = new Set<Listener>();

  /** Returns a function that stops listening. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: StreamMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("event listener failed", error);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
