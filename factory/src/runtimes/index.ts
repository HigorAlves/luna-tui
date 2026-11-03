// The runtimes a stage can run on, by id. The only file that imports a runtime: main.ts reaches
// them through RUNTIMES. An engine on a runtime without an entry here finds none.
import type { RuntimeId } from "@hardness/contracts";

import type { Runtime } from "../core/runtime.ts";
import { claude } from "./claude/run.ts";
import { eve } from "./eve/run.ts";
import { jev } from "./jev/run.ts";

export const RUNTIMES: Partial<Record<RuntimeId, Runtime>> = { claude, eve, jev };
