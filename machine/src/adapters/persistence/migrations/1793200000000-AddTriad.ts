import { MigrationInterface, QueryRunner } from "typeorm";

/** The three numbers a card's second line shows: diff size and tests passed/total (worked time comes from stage runs). */
export class AddTriad1793200000000 implements MigrationInterface {
    name = 'AddTriad1793200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "diff_added" integer`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "diff_removed" integer`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "tests_passed" integer`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "tests_total" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "tests_total"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "tests_passed"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "diff_removed"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "diff_added"`);
    }

}
