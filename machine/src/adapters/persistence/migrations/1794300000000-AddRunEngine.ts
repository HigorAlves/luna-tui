import { MigrationInterface, QueryRunner } from "typeorm";

/** The engine a stage run, or a Slack triage run, ran on; null on rows from before. */
export class AddRunEngine1794300000000 implements MigrationInterface {
    name = 'AddRunEngine1794300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD "engine" text`);
        await queryRunner.query(`ALTER TABLE "slack_triage_runs" ADD "engine" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "slack_triage_runs" DROP COLUMN "engine"`);
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP COLUMN "engine"`);
    }

}
