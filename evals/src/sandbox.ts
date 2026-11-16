// What an eval run's sandbox is made of, so it matches what the machine gives the same pack: the engine relay as the machine sets it,
// the egress list the pack's `network` asks for, and a trusted card (the machine's own stages are trusted; only outside text is not).
import { PACKS, type PackId } from "@hardness/contracts";
import { egressKindOf } from "@hardness/machine/egress-kind";

export interface EvalSandbox {
  /** The options for `machineCredentials`: with the relay on, the real token stays out of the stage. */
  credentials: { engineRelay: boolean };
  /** The egress list: the pack's own, as in a real run. */
  egressKind: "pack" | "github" | "agent";
  trust: "trusted";
}

/** `relay` is the machine's `config.egress.relay`. */
export function evalSandbox(pack: PackId, relay: boolean): EvalSandbox {
  return { credentials: { engineRelay: relay }, egressKind: egressKindOf(PACKS[pack]), trust: "trusted" };
}
