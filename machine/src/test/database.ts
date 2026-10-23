// Test database helpers. Tests use their own database on the dev Postgres, so they never
// touch the data `pnpm dev` works with. Start Postgres first with `pnpm db:up`.
import pg from "pg";
import type { DataSource } from "typeorm";

import { createDataSource } from "../db/data-source.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://hardness:hardness@127.0.0.1:5433/hardness_test";

/** Creates the test database if needed, empties it, and runs every migration. */
export async function freshTestDatabase(): Promise<DataSource> {
  const target = new URL(TEST_DATABASE_URL);
  const name = target.pathname.slice(1);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = "/postgres";

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }

  const db = createDataSource(TEST_DATABASE_URL);
  await db.initialize();
  await db.query("drop schema public cascade; create schema public");
  await db.runMigrations();
  return db;
}
