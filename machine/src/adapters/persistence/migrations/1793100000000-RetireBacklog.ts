import { MigrationInterface, QueryRunner } from "typeorm";

/** A new ticket lands in Intake (`draft`); the `backlog` state is gone. Rows still in it move on. */
export class RetireBacklog1793100000000 implements MigrationInterface {
    name = 'RetireBacklog1793100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "tasks" SET "state" = 'draft' WHERE "state" = 'backlog'`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Nothing to undo: a draft is what a backlog row would have become on its first start.
    }

}
