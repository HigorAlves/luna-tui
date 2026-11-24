import { MigrationInterface, QueryRunner } from "typeorm";

/** A task's own engine per pack (`stages`), over the repo's luna.yaml and the pack's default. */
export class AddTaskStages1794200000000 implements MigrationInterface {
    name = 'AddTaskStages1794200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "stages" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "stages"`);
    }

}
