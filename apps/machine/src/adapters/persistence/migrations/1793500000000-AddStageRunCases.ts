import { MigrationInterface, QueryRunner } from "typeorm";

/** Verifying's verdict per approved case, kept on its stage run so the ticket can show which scenario failed. */
export class AddStageRunCases1793500000000 implements MigrationInterface {
    name = 'AddStageRunCases1793500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD "cases" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP COLUMN "cases"`);
    }

}
