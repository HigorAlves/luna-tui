import { MigrationInterface, QueryRunner } from "typeorm";

/** Which graph a task walks: the feature pipeline, or a PR task's ci_fix / review / address route. */
export class AddRoute1793300000000 implements MigrationInterface {
    name = 'AddRoute1793300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "route" text NOT NULL DEFAULT 'feature'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "route"`);
    }

}
