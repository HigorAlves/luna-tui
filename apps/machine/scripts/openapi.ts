// `pnpm --filter @hardness/machine openapi`: writes the whole API's OpenAPI document to apps/machine/openapi.json.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fullOpenApiDocument } from "../src/adapters/http/openapi/full-document.ts";

const out = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(await fullOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${out}`);
