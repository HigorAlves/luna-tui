import { MigrationInterface, QueryRunner } from "typeorm";

/** The Slack inbox: items (triage and your read state survive restarts) and the watches you save. */
export class AddSlackInbox1793600000000 implements MigrationInterface {
    name = 'AddSlackInbox1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "slack_items" ("id" text NOT NULL, "kind" text NOT NULL, "channel" jsonb NOT NULL, "author" jsonb NOT NULL, "text" text NOT NULL DEFAULT '', "thread_ts" text, "context" jsonb NOT NULL DEFAULT '[]'::jsonb, "permalink" text NOT NULL DEFAULT '', "ts" TIMESTAMP WITH TIME ZONE NOT NULL, "slack_ts" text NOT NULL, "matched" jsonb NOT NULL DEFAULT '[]'::jsonb, "count" integer NOT NULL DEFAULT '1', "replies" integer NOT NULL DEFAULT '0', "you_replied" boolean NOT NULL DEFAULT false, "seen_at" TIMESTAMP WITH TIME ZONE, "done_at" TIMESTAMP WITH TIME ZONE, "snoozed_until" TIMESTAMP WITH TIME ZONE, "reopened_at" TIMESTAMP WITH TIME ZONE, "replied_at" TIMESTAMP WITH TIME ZONE, "arrived_at" TIMESTAMP WITH TIME ZONE NOT NULL, "triage" jsonb, "linked" jsonb NOT NULL DEFAULT '{"pr":null,"taskId":null}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_slack_items" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_slack_items_done_at" ON "slack_items" ("done_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_slack_items_arrived_at" ON "slack_items" ("arrived_at") `);
        await queryRunner.query(`CREATE TABLE "slack_watches" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "kind" text NOT NULL, "value" text NOT NULL, "label" text NOT NULL, "channels" jsonb NOT NULL DEFAULT '[]'::jsonb, "enabled" boolean NOT NULL DEFAULT true, "builtin" boolean NOT NULL DEFAULT false, "priority" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_slack_watches" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_slack_watches_kind_value" ON "slack_watches" ("kind", "value") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_slack_watches_kind_value"`);
        await queryRunner.query(`DROP TABLE "slack_watches"`);
        await queryRunner.query(`DROP INDEX "IDX_slack_items_arrived_at"`);
        await queryRunner.query(`DROP INDEX "IDX_slack_items_done_at"`);
        await queryRunner.query(`DROP TABLE "slack_items"`);
    }

}
