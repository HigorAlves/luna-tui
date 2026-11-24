import { MigrationInterface, QueryRunner } from "typeorm";

/** The ticket object of the Ticket Machine: one per key. The tool owns `canonical`; the machine owns the rest. */
export class AddTickets1794620000000 implements MigrationInterface {
    name = 'AddTickets1794620000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tickets" (
            "key" text NOT NULL,
            "canonical" jsonb NOT NULL,
            "assessments" jsonb NOT NULL DEFAULT '[]',
            "card_id" text,
            "drafts" jsonb NOT NULL DEFAULT '[]',
            "clocks" jsonb NOT NULL DEFAULT '{}',
            "machine_status" text,
            "machine_links" jsonb NOT NULL DEFAULT '[]',
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "PK_tickets" PRIMARY KEY ("key")
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "tickets"`);
    }

}
