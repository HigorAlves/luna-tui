// apps/machine/openapi.json is what frontends generate their clients from: it must be the document the code builds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fullOpenApiDocument } from "./openapi/full-document.ts";

describe("apps/machine/openapi.json", () => {
  it("is the document the routes build, every area on (run `pnpm --filter @hardness/machine openapi` after changing a route)", async () => {
    const committed = JSON.parse(readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8")) as { openapi?: string; paths?: Record<string, unknown> };
    const built = await fullOpenApiDocument();
    expect(built).toMatchObject({ openapi: "3.1.0", servers: [{ url: "http://127.0.0.1:4318" }] });
    expect(Object.keys(built.paths as object).length).toBeGreaterThanOrEqual(99);
    expect(committed).toEqual(built);
  });
});
