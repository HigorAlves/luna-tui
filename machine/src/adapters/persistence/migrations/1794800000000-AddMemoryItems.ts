import { MigrationInterface, QueryRunner } from "typeorm";

/** Memory (RFC 0007): the machine's record of each thing it sent to Cognee, and the day's count of items Cognee built a graph for. Additive. */
export class AddMemoryItems1794800000000 implements MigrationInterface {
    name = 'AddMemoryItems1794800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "memory_items" (
            "id" text NOT NULL,
            "kind" text NOT NULL,
            "repo" text,
            "source_kind" text NOT NULL,
            "source_ref" text,
            "dataset_name" text NOT NULL,
            "dataset_id" text,
            "cognee_data_id" text,
            "anchors" jsonb NOT NULL DEFAULT '{"files":[],"commit":null}',
            "provenance" jsonb NOT NULL,
            "trust" text NOT NULL,
            "status" text NOT NULL DEFAULT 'pending',
            "status_note" text,
            "text" text NOT NULL,
            "content_hash" text NOT NULL,
            "cognified_at" timestamptz,
            "forget_pending" boolean NOT NULL DEFAULT false,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "PK_memory_items" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_repo" ON "memory_items" ("repo")`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_status" ON "memory_items" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_card" ON "memory_items" (("provenance"->>'card'))`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_dataset" ON "memory_items" ("dataset_name", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_hash" ON "memory_items" ("dataset_name", "content_hash")`);
        await queryRunner.query(`CREATE INDEX "IDX_memory_items_data" ON "memory_items" ("cognee_data_id")`);
        await queryRunner.query(`CREATE TABLE "memory_cognify_days" (
            "day" date NOT NULL,
            "items" integer NOT NULL DEFAULT 0,
            CONSTRAINT "PK_memory_cognify_days" PRIMARY KEY ("day")
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "memory_cognify_days"`);
        await queryRunner.query(`DROP TABLE "memory_items"`);
    }

}
