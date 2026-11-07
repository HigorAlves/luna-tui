// A unified diff's added lines with their line number in the new file, and the files that lost a line. Pure.
export interface NumberedLine {
  path: string;
  line: string;
  /** 1-based, in the new file. */
  no: number;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The added lines of `git diff`/`git show` output, each with its new-file line number. */
export function addedWithNumbers(diff: string): NumberedLine[] {
  const added: NumberedLine[] = [];
  let path = "";
  let header = false;
  let no = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      path = "";
    } else if (header && raw.startsWith("+++ ")) {
      path = raw.slice(4).replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      header = false;
      no = Number(HUNK.exec(raw)?.[1] ?? 0);
    } else if (header) {
      continue;
    } else if (path && raw.startsWith("+")) {
      added.push({ path, line: raw.slice(1), no });
      no++;
    } else if (path && raw.startsWith(" ")) {
      no++;
    }
  }
  return added;
}

/** The removed lines of `git diff`/`git show` output, each with its line number in the old file (by the old path). */
export function removedWithNumbers(diff: string): NumberedLine[] {
  const removed: NumberedLine[] = [];
  let path = "";
  let header = false;
  let no = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      path = "";
    } else if (header && raw.startsWith("--- ")) {
      path = raw.slice(4).replace(/^a\//, "");
    } else if (raw.startsWith("@@")) {
      header = false;
      no = Number(/^@@ -(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (header) {
      continue;
    } else if (path && raw.startsWith("-")) {
      removed.push({ path, line: raw.slice(1), no });
      no++;
    } else if (path && raw.startsWith(" ")) {
      no++;
    }
  }
  return removed;
}

/** The paths that lost a line (or whole file content) in the diff. */
export function pathsWithRemovals(diff: string): Set<string> {
  const paths = new Set<string>();
  let path = "";
  let header = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      path = "";
    } else if (header && raw.startsWith("--- ")) {
      path = raw.slice(4).replace(/^a\//, "");
    } else if (raw.startsWith("@@")) {
      header = false;
    } else if (!header && path && raw.startsWith("-")) {
      paths.add(path);
    }
  }
  return paths;
}
