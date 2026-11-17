// Builds the brain at boot (RFC 0010): the Brain over omnigraph-server when an address and the three `luna-*` tokens are there, `noBrain()`
// otherwise, with one line saying which and why. The line never carries a token. The server being down is not checked here: it is
// found on the first call, and the machine works the same.
import { readFileSync } from "node:fs";

import { type Brain, noBrain } from "../../application/brain.ts";
import { omnigraphBrain } from "./brain.ts";
import { omnigraphClient } from "./client.ts";

const GRAPH = "brain";
const NEEDED = ["luna-facts", "luna-memories", "luna-reader"] as const;

export function brainAtBoot(options: { url: string | null; tokensPath: string }): { brain: Brain; line: string } {
  const off = (why: string) => ({ brain: noBrain(), line: `brain: off, ${why}` });
  if (!options.url) return off("MACHINE_BRAIN_URL is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(options.tokensPath, "utf8"));
  } catch (error) {
    // A parse error's message can quote the file, so only the kind of failure is said.
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return off(missing ? `no tokens file at ${options.tokensPath}` : `the tokens file ${options.tokensPath} could not be read as JSON`);
  }
  const file = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const lacking = NEEDED.filter((name) => typeof file[name] !== "string" || file[name] === "");
  if (lacking.length > 0) return off(`${options.tokensPath} has no ${lacking.join(", ")}`);
  const tokens = { facts: file["luna-facts"] as string, memories: file["luna-memories"] as string, reader: file["luna-reader"] as string };
  return { brain: omnigraphBrain({ client: omnigraphClient({ baseUrl: options.url, graph: GRAPH }), tokens, log: (line) => console.warn(line) }), line: `brain: on, ${options.url} (graph ${GRAPH})` };
}
