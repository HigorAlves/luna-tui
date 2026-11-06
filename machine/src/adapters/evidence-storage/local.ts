// The `local` target: nothing is uploaded and every media entry stays a copy under the machine's own store (printed as "(local copy)", never as a host path).
import { type EvidenceStorage, localStorage } from "../../application/evidence-storage.ts";

export const localEvidenceStorage = (): EvidenceStorage => localStorage();
