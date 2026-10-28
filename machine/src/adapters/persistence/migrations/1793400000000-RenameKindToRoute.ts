import { MigrationInterface, QueryRunner } from "typeorm";

/** One field says which graph a task walks: `feature`, `setup` (proposes the repo's luna.yaml and
 *  closes), or a PR task's `ci_fix` / `review` / `address`. The `kind` column held the first two. */
export class RenameKindToRoute1793400000000 implements MigrationInterface {
    name = 'RenameKindToRoute1793400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" RENAME COLUMN "kind" TO "route"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" RENAME COLUMN "route" TO "kind"`);
    }

}
