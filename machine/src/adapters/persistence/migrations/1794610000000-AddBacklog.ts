import { MigrationInterface, QueryRunner } from "typeorm";

/** The shared backlog: candidates that are not cards yet, ranked by cost of delay over cost of doing. */
export class AddBacklog1794610000000 implements MigrationInterface {
    name = 'AddBacklog1794610000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "backlog_items" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "title" text NOT NULL,
            "text" text NOT NULL DEFAULT '',
            "sources" jsonb NOT NULL DEFAULT '[]',
            "repo" text,
            "scores" jsonb NOT NULL,
            "size" text NOT NULL,
            "demand" integer NOT NULL DEFAULT 1,
            "depends_on" jsonb NOT NULL DEFAULT '[]',
            "added_at" timestamptz NOT NULL DEFAULT now(),
            "assessed_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "PK_backlog_items" PRIMARY KEY ("id")
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "backlog_items"`);
    }

}
