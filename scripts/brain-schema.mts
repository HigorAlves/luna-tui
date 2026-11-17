// Writes brain/schema.pg from the brain's tables (`pnpm brain:schema`). A contracts test fails when the file is stale.
import { writeFileSync } from "node:fs";

import { renderBrainSchema } from "../contracts/src/brain-schema.ts";

writeFileSync(new URL("../brain/schema.pg", import.meta.url), renderBrainSchema());
