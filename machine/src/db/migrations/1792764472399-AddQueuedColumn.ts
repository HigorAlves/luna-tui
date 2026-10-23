import { MigrationInterface, QueryRunner } from "typeorm";

export class AddQueuedColumn1792764472399 implements MigrationInterface {
    name = 'AddQueuedColumn1792764472399'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "queued" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "criteria" SET DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb`);
        await queryRunner.query(`ALTER TABLE "approvals" ALTER COLUMN "requested" SET DEFAULT '{}'::jsonb`);
        await queryRunner.query(`CREATE INDEX "IDX_c67f3b2af47c42c62ef87238f4" ON "tasks"  ("queued") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c67f3b2af47c42c62ef87238f4"`);
        await queryRunner.query(`ALTER TABLE "approvals" ALTER COLUMN "requested" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "payload" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "criteria" SET DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "queued"`);
    }

}
