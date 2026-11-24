import { MigrationInterface, QueryRunner } from "typeorm";

/** What a run's result named it ran on (RFC 0003 §7): its runtime, the pinned model ID, the SDK
 *  version and the harness fingerprint; null on rows from before. */
export class AddRunFingerprint1794560000000 implements MigrationInterface {
    name = 'AddRunFingerprint1794560000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of ["stage_runs", "pack_runs", "slack_triage_runs"]) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "runtime" text, ADD "model_id" text, ADD "sdk_version" text, ADD "fingerprint" text`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of ["slack_triage_runs", "pack_runs", "stage_runs"]) {
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "fingerprint", DROP COLUMN "sdk_version", DROP COLUMN "model_id", DROP COLUMN "runtime"`);
        }
    }

}
