import { MigrationInterface, QueryRunner } from "typeorm";

/** One row per slack_triage pack run: items, turns and cost, so the Floor can show what triage costs. */
export class AddSlackTriageRuns1793700000000 implements MigrationInterface {
    name = 'AddSlackTriageRuns1793700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "slack_triage_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE NOT NULL, "items" integer NOT NULL DEFAULT '0', "model" text NOT NULL DEFAULT '', "turns" integer NOT NULL DEFAULT '0', "cost_usd" numeric(10,4), "ok" boolean NOT NULL DEFAULT false, "error" text, CONSTRAINT "PK_slack_triage_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_slack_triage_runs_started_at" ON "slack_triage_runs" ("started_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_slack_triage_runs_started_at"`);
        await queryRunner.query(`DROP TABLE "slack_triage_runs"`);
    }

}
