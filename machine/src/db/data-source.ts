// One DataSource factory for the app and tests, and a default export for the TypeORM CLI
// (`pnpm db:migrate`, `pnpm db:generate`).
import { DataSource } from "typeorm";

import { loadConfig } from "../config.ts";
import { ENTITIES } from "./schemas.ts";
import { MIGRATIONS } from "./migrations/index.ts";

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: "postgres",
    url,
    // gen_random_uuid() is built into Postgres 13+, so no extension has to be installed.
    uuidExtension: "pgcrypto",
    entities: ENTITIES,
    // Listed explicitly rather than globbed, so loading never depends on the runner.
    migrations: MIGRATIONS,
    // The schema only changes through migrations.
    synchronize: false,
    logging: false,
  });
}

export default createDataSource(loadConfig().databaseUrl);
