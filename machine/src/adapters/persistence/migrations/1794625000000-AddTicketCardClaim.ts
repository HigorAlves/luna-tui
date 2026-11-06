import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddTicketCardClaim1794625000000 implements MigrationInterface {
    name = 'AddTicketCardClaim1794625000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // When a tap on "make a card" claimed the ticket's card creation: one claim at a time, an old one is retaken.
        await queryRunner.query(`ALTER TABLE "tickets" ADD "card_claimed_at" timestamptz`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tickets" DROP COLUMN "card_claimed_at"`);
    }
}
