// The event kinds only the machine writes. A stage container can write any line into /out/events.jsonl, and the machine stores each as `stage.<kind>`
// (a kind that already starts with `stage.` is stored as it is), so a container could write a row that looks like the machine's own: `stage.finished`
// with a forged tests commit or a negative token count. Nothing the checks rely on may come from such a row, and at ingest a container's line whose
// stored kind would be one of these is dropped.
import { STAGE_REPORTS } from "./card-events.ts";

/** Rows the machine logs itself under a `stage.` kind (the pipeline's, the pack runner's, the stages'): never from a container. `stage.note` is not here: the container's own notes are stored under it. */
const MACHINE_STAGE_KINDS = ["stage.started", "stage.finished", "stage.engine", "stage.held", "stage.reattached", "stage.restarted", "stage.malformed", "stage.sandbox.egress_blocked"];

/** The kinds the agent's own tools write (the slice ledger) and its notes: a container may write these. */
export const CONTAINER_STAGE_KINDS = ["stage.slice.red", "stage.slice.green", "stage.slice.committed", "stage.note"];

/** What a stage-reported name (`pr.opened`, `build.checkpoint`, `ship.ready`...) is stored under: rows a machine stage reports, never a container. */
const REPORTED = [...STAGE_REPORTS].map((name) => `stage.${name}`);

export const RESERVED_KINDS: readonly string[] = [...MACHINE_STAGE_KINDS, ...REPORTED];

/** The kind a container's event is stored under. */
export const finalKind = (kind: string): string => (kind.startsWith("stage.") ? kind : `stage.${kind}`);

/** Whether a container's event of this kind would be stored as a row only the machine writes. */
export const isReservedKind = (kind: string): boolean => RESERVED_KINDS.includes(finalKind(kind));
