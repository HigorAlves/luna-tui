import { MigrationInterface, QueryRunner } from "typeorm";

/** The `Idempotency-Key` a work order came with and a hash of its body: a retry with the same key answers the task already made. */
export class AddTaskIdempotencyKey1794000000000 implements MigrationInterface {
    name = 'AddTaskIdempotencyKey1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "idempotency_key" text, ADD "request_hash" text`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_tasks_idempotency_key" ON "tasks" ("idempotency_key")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_tasks_idempotency_key"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "request_hash", DROP COLUMN "idempotency_key"`);
    }

}
