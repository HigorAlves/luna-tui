// Which card merged a given PR or commit: read off the `ship.merged` events (and the older `task.shipped`) the pipeline logged.
import type { DataSource } from "typeorm";

/** The card that merged PR `number` of `repo` (`owner/name`), or the commit `sha` (7 to 40 hex digits, a prefix), the latest first; null when none did. */
export async function cardMergedAs(db: DataSource, target: { repo: string; number: number } | { sha: string }): Promise<string | null> {
  if ("sha" in target) {
    if (!/^[0-9a-f]{7,40}$/.test(target.sha)) return null;
    const rows: Array<{ task_id: string }> = await db.query(
      `select task_id from events where kind in ('ship.merged', 'task.shipped') and lower(payload->>'mergedSha') like $1 order by id desc limit 1`,
      [`${target.sha}%`],
    );
    return rows[0]?.task_id ?? null;
  }
  // The PR's address ends `/<owner>/<name>/pull/<number>`; a repository name is never a LIKE pattern.
  const slug = target.repo.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows: Array<{ task_id: string }> = await db.query(
    `select task_id from events where kind in ('ship.merged', 'task.shipped') and (payload->>'number')::int = $1 and lower(payload->>'prUrl') like $2 escape '\\' order by id desc limit 1`,
    [target.number, `%/${slug}/pull/${target.number}`],
  );
  return rows[0]?.task_id ?? null;
}
