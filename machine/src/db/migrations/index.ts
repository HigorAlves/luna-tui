// Every migration, oldest first. Add each newly generated migration here.
import { Init1792712166445 } from "./1792712166445-Init.ts";
import { AddQueuedColumn1792764472399 } from "./1792764472399-AddQueuedColumn.ts";

export const MIGRATIONS: Function[] = [Init1792712166445, AddQueuedColumn1792764472399];
