// The Jira link a task carries, and the branch a linked task works on. Pure.
import type { JiraLink, TaskSource } from "@hardness/contracts";

import { DEFAULT_JIRA_BRANCH } from "./policy.ts";

/** A bare link: the key and url, nothing JiraWatch has filled in yet; `linkedAt` when the link was made by hand (null: with the ticket). */
export function bareLink(key: string, url: string, issueType: string | null = null, linkedAt: string | null = null): JiraLink {
  return { key, url, issueType, status: null, priority: null, dueAt: null, syncedAt: null, blocked: null, linkedAt, timeZone: null };
}

/** The task's Jira link: the column, or, for an intake import never refreshed yet, the key its source carries. */
export function jiraOf(row: { jira: JiraLink | null; source: TaskSource | null }): JiraLink | null {
  if (row.jira) return row.jira;
  if (row.source?.kind !== "jira") return null;
  return bareLink(row.source.key, row.source.url, row.source.issueType);
}

/** Lowercase ascii words joined by `-`. Never empty. */
export function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return words || "task";
}

/** The issue type as a branch segment: `Story` → `story`, `Tech Debt` → `tech-debt`; unknown → `task`. */
export function branchType(issueType: string | null | undefined): string {
  const type = (issueType ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return type || "task";
}

/** Branches no task may ever work on, whatever a pattern or a row says. */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "develop"]);

/** Why a `jira.branch` pattern cannot be used, or null when it can: it must carry `{key}` or `{id}`,
 *  so two tasks never share a branch and no render is ever a bare `main`, `master` or `develop`
 *  (the pack runner refuses those, and the repo's default branch, at run time all the same). */
export function branchPatternProblem(pattern: string): string | null {
  if (!pattern.includes("{key}") && !pattern.includes("{id}")) return `"${pattern}" must contain {key} or {id}, so every task gets its own branch`;
  return null;
}

/** The branch for a linked task from the repo's pattern: `{type}`, `{key}`, `{slug}`, `{route}`, `{id}`. */
export function jiraBranch(task: { id: string; title: string; route: string; jira: JiraLink | null; source: TaskSource | null }, pattern: string = DEFAULT_JIRA_BRANCH): string | null {
  const link = jiraOf(task);
  if (!link) return null;
  const rendered = pattern
    .replaceAll("{type}", branchType(link.issueType))
    .replaceAll("{key}", link.key)
    .replaceAll("{slug}", slug(task.title))
    .replaceAll("{route}", task.route)
    .replaceAll("{id}", task.id.slice(0, 8));
  // A branch name must be something git takes and the worktree layout can hold.
  const clean = rendered.replace(/[\s~^:?*[\]\\]+/g, "-").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.\.+/g, ".");
  return clean || null;
}
