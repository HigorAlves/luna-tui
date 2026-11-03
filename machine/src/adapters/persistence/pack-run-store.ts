// The pack_runs table: one row per `POST /runs` call that ran (application/pack-runs.ts).
import type { DataSource } from "typeorm";

import type { PackRunRecord, PackRunStore } from "../../application/pack-runs.ts";
import { PackRunEntity } from "./schemas.ts";

export interface PackRunEntityRow {
  id: string;
  pack: string;
  engine: string;
  model: string;
  client: string | null;
  ok: boolean;
  error: string | null;
  turns: number;
  durationMs: number;
  /** numeric comes back from pg as a string. */
  costUsd: string | number | null;
  runtime: string | null;
  modelId: string | null;
  sdkVersion: string | null;
  fingerprint: string | null;
  startedAt: Date;
  endedAt: Date;
}

export class PgPackRunStore implements PackRunStore {
  constructor(private readonly db: DataSource) {}

  async record(run: PackRunRecord): Promise<void> {
    await this.db.getRepository(PackRunEntity).save({
      pack: run.pack,
      engine: run.engine,
      model: run.model,
      client: run.client,
      ok: run.ok,
      error: run.error,
      turns: run.turns,
      durationMs: Math.round(run.durationMs),
      costUsd: run.costUsd,
      runtime: run.runtime ?? null,
      modelId: run.modelId ?? null,
      sdkVersion: run.sdkVersion ?? null,
      fingerprint: run.fingerprint ?? null,
      startedAt: new Date(run.startedAt),
      endedAt: new Date(run.endedAt),
    });
  }
}
