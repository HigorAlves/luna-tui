import { MigrationInterface, QueryRunner } from "typeorm";

/** Every task change takes the next `task_seq` (`tasks.seq`), and a deleted task leaves a tombstone
 *  with its own, so `GET /events?since=` can replay what a client missed. The trigger takes one
 *  transaction-scoped advisory lock before the number, so numbers are handed out in commit order:
 *  a reader that has seen N never later finds a committed change below N. */
export class AddTaskSeq1794100000000 implements MigrationInterface {
    name = 'AddTaskSeq1794100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SEQUENCE "task_seq"`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "seq" bigint NOT NULL DEFAULT nextval('task_seq')`);
        await queryRunner.query(`CREATE INDEX "IDX_tasks_seq" ON "tasks" ("seq")`);
        await queryRunner.query(`CREATE TABLE "task_tombstones" ("id" uuid PRIMARY KEY, "seq" bigint NOT NULL, "source" jsonb, "deleted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now())`);
        await queryRunner.query(`CREATE INDEX "IDX_task_tombstones_seq" ON "task_tombstones" ("seq")`);
        await queryRunner.query(`CREATE FUNCTION "task_seq_stamp"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7419400001);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO "task_tombstones" ("id", "seq", "source") VALUES (OLD."id", nextval('task_seq'), OLD."source");
    RETURN OLD;
  END IF;
  NEW."seq" := nextval('task_seq');
  RETURN NEW;
END $$`);
        await queryRunner.query(`CREATE TRIGGER "tasks_seq" BEFORE INSERT OR UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION "task_seq_stamp"()`);
        await queryRunner.query(`CREATE TRIGGER "tasks_tombstone" AFTER DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION "task_seq_stamp"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "tasks_tombstone" ON "tasks"`);
        await queryRunner.query(`DROP TRIGGER "tasks_seq" ON "tasks"`);
        await queryRunner.query(`DROP FUNCTION "task_seq_stamp"()`);
        await queryRunner.query(`DROP TABLE "task_tombstones"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "seq"`);
        await queryRunner.query(`DROP SEQUENCE "task_seq"`);
    }

}
