import { MigrationInterface, QueryRunner } from "typeorm";

export class FactorySeam1792900000000 implements MigrationInterface {
    name = 'FactorySeam1792900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "source" jsonb`);
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD "cost_usd" numeric`);
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD "turns" integer`);
        await queryRunner.query(`CREATE TABLE "artifacts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "stage_run_id" uuid NOT NULL, "task_id" uuid NOT NULL, "kind" text NOT NULL, "path" text NOT NULL, "label" text NOT NULL DEFAULT '', "sha256" text NOT NULL DEFAULT '', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_artifacts_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_artifacts_task_id" ON "artifacts"  ("task_id") `);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_stage_run_id" FOREIGN KEY ("stage_run_id") REFERENCES "stage_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_task_id" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_task_id"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_stage_run_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifacts_task_id"`);
        await queryRunner.query(`DROP TABLE "artifacts"`);
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP COLUMN "turns"`);
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP COLUMN "cost_usd"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "source"`);
    }

}
