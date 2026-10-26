import { MigrationInterface, QueryRunner } from "typeorm";

export class AddQueuedAt1793000000000 implements MigrationInterface {
    name = 'AddQueuedAt1793000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "queued_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`UPDATE "tasks" SET "queued_at" = "updated_at" WHERE "queued" = true`);
        await queryRunner.query(`CREATE INDEX "IDX_tasks_queued_at" ON "tasks" ("queued", "queued_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_tasks_queued_at"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "queued_at"`);
    }

}
