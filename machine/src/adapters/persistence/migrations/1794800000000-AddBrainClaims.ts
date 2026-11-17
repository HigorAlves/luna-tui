import { MigrationInterface, QueryRunner } from "typeorm";

/** The claim journal (RFC 0010, "Remember"): every claim a pack or a person handed over, with where admission and the person settled it. Additive. */
export class AddBrainClaims1794800000000 implements MigrationInterface {
    name = 'AddBrainClaims1794800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "brain_claims" (
            "id" uuid NOT NULL,
            "repo_path" text,
            "repo" text,
            "task_id" uuid,
            "statement" text NOT NULL,
            "quote" text NOT NULL,
            "kind" text NOT NULL,
            "scope" text NOT NULL,
            "source_kind" text NOT NULL,
            "source_ref" text NOT NULL,
            "source_title" text NOT NULL,
            "speaker" text,
            "speaker_trust" text NOT NULL,
            "extractor" text NOT NULL,
            "status" text NOT NULL,
            "refusal" text,
            "tier" text,
            "proposed" text,
            "reasons" jsonb NOT NULL DEFAULT '[]',
            "durable" boolean,
            "contradicts" jsonb NOT NULL DEFAULT '[]',
            "record_id" text,
            "decided_by" text,
            "decided_at" timestamptz,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "PK_brain_claims" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX "IDX_brain_claims_status" ON "brain_claims" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_brain_claims_updated_at" ON "brain_claims" ("updated_at")`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_brain_claims_source_statement" ON "brain_claims" ("source_kind", "source_ref", "statement")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "brain_claims"`);
    }

}
