// Every migration, oldest first. Add each newly generated migration here.
import { Init1792712166445 } from "./1792712166445-Init.ts";
import { AddQueuedColumn1792764472399 } from "./1792764472399-AddQueuedColumn.ts";
import { FactorySeam1792900000000 } from "./1792900000000-FactorySeam.ts";
import { AddQueuedAt1793000000000 } from "./1793000000000-AddQueuedAt.ts";

export const MIGRATIONS: Function[] = [
  Init1792712166445,
  AddQueuedColumn1792764472399,
  FactorySeam1792900000000,
  AddQueuedAt1793000000000,
];
