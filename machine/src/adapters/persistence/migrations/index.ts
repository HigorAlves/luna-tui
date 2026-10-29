// Every migration, oldest first. Add each newly generated migration here.
import { Init1792712166445 } from "./1792712166445-Init.ts";
import { AddQueuedColumn1792764472399 } from "./1792764472399-AddQueuedColumn.ts";
import { FactorySeam1792900000000 } from "./1792900000000-FactorySeam.ts";
import { AddQueuedAt1793000000000 } from "./1793000000000-AddQueuedAt.ts";
import { RetireBacklog1793100000000 } from "./1793100000000-RetireBacklog.ts";
import { AddTriad1793200000000 } from "./1793200000000-AddTriad.ts";
import { AddTaskKind1793300000000 } from "./1793300000000-AddTaskKind.ts";
import { RenameKindToRoute1793400000000 } from "./1793400000000-RenameKindToRoute.ts";
import { AddStageRunCases1793500000000 } from "./1793500000000-AddStageRunCases.ts";
import { AddSlackInbox1793600000000 } from "./1793600000000-AddSlackInbox.ts";
import { AddSlackTriageRuns1793700000000 } from "./1793700000000-AddSlackTriageRuns.ts";

export const MIGRATIONS: Function[] = [
  Init1792712166445,
  AddQueuedColumn1792764472399,
  FactorySeam1792900000000,
  AddQueuedAt1793000000000,
  RetireBacklog1793100000000,
  AddTriad1793200000000,
  AddTaskKind1793300000000,
  RenameKindToRoute1793400000000,
  AddStageRunCases1793500000000,
  AddSlackInbox1793600000000,
  AddSlackTriageRuns1793700000000,
];
