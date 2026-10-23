import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1792712166445 implements MigrationInterface {
    name = 'Init1792712166445'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "title" text NOT NULL, "description" text NOT NULL DEFAULT '', "criteria" jsonb NOT NULL DEFAULT '[]'::jsonb, "repo_path" text, "branch" text, "worktree_path" text, "state" text NOT NULL, "retries" jsonb NOT NULL, "resume_to" text, "reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "stage_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "task_id" uuid NOT NULL, "stage" text NOT NULL, "attempt" integer NOT NULL, "status" text NOT NULL, "outcome" text, "container_id" text, "input_commit" text, "output_commit" text, "transcript_path" text, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_1eb494702c129319271eb7db0a4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5aa28076b4d589bf57c191b499" ON "stage_runs"  ("task_id") `);
        await queryRunner.query(`CREATE TABLE "events" ("id" BIGSERIAL NOT NULL, "task_id" uuid NOT NULL, "stage_run_id" uuid, "kind" text NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_40731c7151fe4be3116e45ddf73" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a86dd0bffcb3dc85ba4ee8ac8e" ON "events"  ("task_id") `);
        await queryRunner.query(`CREATE TABLE "approvals" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "task_id" uuid NOT NULL, "kind" text NOT NULL, "requested" jsonb NOT NULL DEFAULT '{}'::jsonb, "decision" text, "reason" text, "response" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "decided_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_690417aaefa84d18b1a59e2a499" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a58525528c251b82c7372c8229" ON "approvals"  ("task_id") `);
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD CONSTRAINT "FK_5aa28076b4d589bf57c191b4994" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "events" ADD CONSTRAINT "FK_a86dd0bffcb3dc85ba4ee8ac8e2" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "FK_a58525528c251b82c7372c8229d" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "FK_a58525528c251b82c7372c8229d"`);
        await queryRunner.query(`ALTER TABLE "events" DROP CONSTRAINT "FK_a86dd0bffcb3dc85ba4ee8ac8e2"`);
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP CONSTRAINT "FK_5aa28076b4d589bf57c191b4994"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a58525528c251b82c7372c8229"`);
        await queryRunner.query(`DROP TABLE "approvals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a86dd0bffcb3dc85ba4ee8ac8e"`);
        await queryRunner.query(`DROP TABLE "events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5aa28076b4d589bf57c191b499"`);
        await queryRunner.query(`DROP TABLE "stage_runs"`);
        await queryRunner.query(`DROP TABLE "tasks"`);
    }

}
