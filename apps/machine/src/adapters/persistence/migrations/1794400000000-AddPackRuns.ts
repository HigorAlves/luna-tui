import { MigrationInterface, QueryRunner } from "typeorm";

/** One row per `POST /runs` call that ran: which pack, engine and model, who asked, how it ended
 *  and what it cost. Never the context the client sent nor the answer. */
export class AddPackRuns1794400000000 implements MigrationInterface {
    name = 'AddPackRuns1794400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pack_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "pack" text NOT NULL, "engine" text NOT NULL, "model" text NOT NULL DEFAULT '', "client" text, "ok" boolean NOT NULL DEFAULT false, "error" text, "turns" integer NOT NULL DEFAULT '0', "duration_ms" integer NOT NULL DEFAULT '0', "cost_usd" numeric(10,4), "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_pack_runs" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_pack_runs_started_at" ON "pack_runs" ("started_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_pack_runs_started_at"`);
        await queryRunner.query(`DROP TABLE "pack_runs"`);
    }

}
