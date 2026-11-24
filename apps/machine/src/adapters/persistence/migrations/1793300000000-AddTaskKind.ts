import { MigrationInterface, QueryRunner } from "typeorm";

/** `feature` is a ticket through the pipeline; `setup` only proposes the repo's luna.yaml and closes. */
export class AddTaskKind1793300000000 implements MigrationInterface {
    name = 'AddTaskKind1793300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "kind" text NOT NULL DEFAULT 'feature'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "kind"`);
    }

}
