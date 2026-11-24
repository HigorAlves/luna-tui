import { MigrationInterface, QueryRunner } from "typeorm";

/** The conversation object on a Slack item (null on rows from before), and the drafts that wait for a person's tap. Additive. */
export class AddConversations1794700000000 implements MigrationInterface {
    name = 'AddConversations1794700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "slack_items" ADD "conversation" jsonb`);
        await queryRunner.query(`CREATE TABLE "slack_drafts" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "thread" text NOT NULL,
            "channel" text NOT NULL,
            "thread_ts" text NOT NULL,
            "kind" text NOT NULL,
            "status" text NOT NULL DEFAULT 'waiting',
            "text" text NOT NULL,
            "original" text,
            "card_id" text,
            "private" boolean NOT NULL DEFAULT false,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "expires_at" timestamptz NOT NULL,
            "decided_at" timestamptz,
            "history" jsonb NOT NULL DEFAULT '[]',
            "records" jsonb NOT NULL DEFAULT '{}',
            CONSTRAINT "PK_slack_drafts" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_slack_drafts_waiting" ON "slack_drafts" ("thread") WHERE "status" = 'waiting'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "slack_drafts"`);
        await queryRunner.query(`ALTER TABLE "slack_items" DROP COLUMN "conversation"`);
    }

}
