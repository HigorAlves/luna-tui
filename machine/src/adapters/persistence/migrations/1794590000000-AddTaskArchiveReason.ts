import { MigrationInterface, QueryRunner } from "typeorm";

/** Why a task was archived (`archiveReason`); the `archived` state itself is text and needs no change. */
export class AddTaskArchiveReason1794590000000 implements MigrationInterface {
    name = 'AddTaskArchiveReason1794590000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "archiveReason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "archiveReason"`);
    }

}
