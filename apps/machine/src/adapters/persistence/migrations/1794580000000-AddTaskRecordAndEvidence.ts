import { MigrationInterface, QueryRunner } from "typeorm";

/** What triage decided about a ticket (`record`) and the evidence pack of its change (`evidence`),
 *  both kept on the task (RFC 0005). */
export class AddTaskRecordAndEvidence1794580000000 implements MigrationInterface {
    name = 'AddTaskRecordAndEvidence1794580000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "record" jsonb, ADD "evidence" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "evidence", DROP COLUMN "record"`);
    }

}
