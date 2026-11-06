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
import { AddTaskJira1793800000000 } from "./1793800000000-AddTaskJira.ts";
import { AddTaskStateSince1793900000000 } from "./1793900000000-AddTaskStateSince.ts";
import { AddTaskIdempotencyKey1794000000000 } from "./1794000000000-AddTaskIdempotencyKey.ts";
import { AddTaskSeq1794100000000 } from "./1794100000000-AddTaskSeq.ts";
import { AddTaskStages1794200000000 } from "./1794200000000-AddTaskStages.ts";
import { AddRunEngine1794300000000 } from "./1794300000000-AddRunEngine.ts";
import { AddPackRuns1794400000000 } from "./1794400000000-AddPackRuns.ts";
import { AddRunFingerprint1794560000000 } from "./1794560000000-AddRunFingerprint.ts";
import { AddTaskClassification1794570000000 } from "./1794570000000-AddTaskClassification.ts";
import { AddTaskRecordAndEvidence1794580000000 } from "./1794580000000-AddTaskRecordAndEvidence.ts";
import { AddTaskArchiveReason1794590000000 } from "./1794590000000-AddTaskArchiveReason.ts";
import { AddTaskCard1794600000000 } from "./1794600000000-AddTaskCard.ts";
import { AddBacklog1794610000000 } from "./1794610000000-AddBacklog.ts";
import { AddTickets1794620000000 } from "./1794620000000-AddTickets.ts";
import { AddConversations1794700000000 } from "./1794700000000-AddConversations.ts";

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
  AddTaskJira1793800000000,
  AddTaskStateSince1793900000000,
  AddTaskIdempotencyKey1794000000000,
  AddTaskSeq1794100000000,
  AddTaskStages1794200000000,
  AddRunEngine1794300000000,
  AddPackRuns1794400000000,
  AddRunFingerprint1794560000000,
  AddTaskClassification1794570000000,
  AddTaskRecordAndEvidence1794580000000,
  AddTaskArchiveReason1794590000000,
  AddTaskCard1794600000000,
  AddBacklog1794610000000,
  AddTickets1794620000000,
  AddConversations1794700000000,
];
