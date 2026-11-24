import { MigrationInterface, QueryRunner } from "typeorm";

/** What triage_signals said about the issue a task came from (`classification`), and pack_runs'
 *  cost to the micro-dollar: a Jev call costs a few thousandths of a cent, which four places
 *  recorded as nothing. */
export class AddTaskClassification1794570000000 implements MigrationInterface {
    name = 'AddTaskClassification1794570000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "classification" jsonb`);
        await queryRunner.query(`ALTER TABLE "pack_runs" ALTER COLUMN "cost_usd" TYPE numeric(14,8)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pack_runs" ALTER COLUMN "cost_usd" TYPE numeric(10,4)`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "classification"`);
    }

}
