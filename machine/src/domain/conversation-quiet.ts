// Whether people are already talking in a thread: another person (not the operator, not a bot) replied inside the window, so no draft is written. Pure.
import type { CanonicalMessage } from "@hardness/contracts";

export function humansActive(history: CanonicalMessage[], me: string, now: Date, windowMinutes: number): boolean {
  const since = now.getTime() - windowMinutes * 60_000;
  return history.slice(1).some((m) => !m.deleted && !m.author.isBot && m.author.id !== me && Number(m.ts) * 1000 >= since);
}
