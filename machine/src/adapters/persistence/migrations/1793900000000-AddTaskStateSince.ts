import { MigrationInterface, QueryRunner } from "typeorm";

/** When the task entered its current state, set on every transition, so the SLA clocks read one
 *  column instead of scanning the task's events. Backfilled from the latest transition event
 *  (created_at for a task that never moved). */
export class AddTaskStateSince1793900000000 implements MigrationInterface {
    name = 'AddTaskStateSince1793900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "state_since" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`UPDATE "tasks" t SET "state_since" = coalesce((SELECT max(e."at") FROM "events" e WHERE e."task_id" = t."id" AND e."kind" = 'transition'), t."created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "state_since"`);
    }

}
