import { MigrationInterface, QueryRunner } from "typeorm";

/** The commit a stage run first started from (`baseCommit`), written once: `input_commit` is overwritten by each container of the run (the tests writer, then the implementer). */
export class AddStageRunBaseCommit1794595000000 implements MigrationInterface {
    name = 'AddStageRunBaseCommit1794595000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stage_runs" ADD "base_commit" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stage_runs" DROP COLUMN "base_commit"`);
    }

}
