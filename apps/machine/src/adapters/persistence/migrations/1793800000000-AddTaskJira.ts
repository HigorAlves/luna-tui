import { MigrationInterface, QueryRunner } from "typeorm";

/** The linked Jira issue on a task (`JiraLink`): key, url, status, priority, due date, sync time and the last refused transition. */
export class AddTaskJira1793800000000 implements MigrationInterface {
    name = 'AddTaskJira1793800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "jira" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "jira"`);
    }

}
