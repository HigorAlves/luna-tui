import { MigrationInterface, QueryRunner } from "typeorm";

/** The Datadog inbox: items (triage and your done state survive restarts) and one row per datadog_triage run. */
export class AddDatadogInbox1794000000000 implements MigrationInterface {
    name = 'AddDatadogInbox1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "datadog_items" ("id" text NOT NULL, "row" jsonb NOT NULL, "last_seen" TIMESTAMP WITH TIME ZONE NOT NULL, "done_at" TIMESTAMP WITH TIME ZONE, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_datadog_items" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "datadog_items_done_at_idx" ON "datadog_items" ("done_at") `);
        await queryRunner.query(`CREATE TABLE "datadog_triage_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE NOT NULL, "items" integer NOT NULL DEFAULT '0', "model" text NOT NULL DEFAULT '', "turns" integer NOT NULL DEFAULT '0', "cost_usd" numeric(10,4), "ok" boolean NOT NULL DEFAULT false, "error" text, CONSTRAINT "PK_datadog_triage_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_datadog_triage_runs_started_at" ON "datadog_triage_runs" ("started_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_datadog_triage_runs_started_at"`);
        await queryRunner.query(`DROP TABLE "datadog_triage_runs"`);
        await queryRunner.query(`DROP INDEX "datadog_items_done_at_idx"`);
        await queryRunner.query(`DROP TABLE "datadog_items"`);
    }

}
