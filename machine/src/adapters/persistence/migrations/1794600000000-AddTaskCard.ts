import { MigrationInterface, QueryRunner } from "typeorm";

/** What a card keeps of the entry contract (sources, reporter, hints, attachments, project, owners, followers); null on a row from before. */
export class AddTaskCard1794600000000 implements MigrationInterface {
    name = 'AddTaskCard1794600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" ADD "card" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "card"`);
    }

}
