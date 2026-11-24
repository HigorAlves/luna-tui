// The wiki port: a repository's GitHub wiki as markdown pages. GitHub has no API for a wiki, so the git adapter
// works on `<slug>.wiki.git` with the person's own credentials. Every call throws a `WikiError` with the reason
// in plain words; callers that report instead of throwing catch it.

export class WikiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiError";
  }
}

export interface WikiPage {
  /** Relative to the wiki root, ends in `.md`, `/` separated. */
  path: string;
  text: string;
}

export interface Wiki {
  /** Every .md page under `prefix` ("" for all), paths relative to the wiki root, sorted. */
  readPages(slug: string, prefix: string): Promise<WikiPage[]>;
  /** Writes the pages in one commit and pushes it; returns the pushed sha. Unchanged pages make no commit and return the current sha. */
  writePages(slug: string, pages: WikiPage[], message: string): Promise<{ sha: string }>;
}

/** The fallback when wikis cannot be reached: every call rejects with `reason`. */
export function noWiki(reason: string): Wiki {
  const refuse = () => Promise.reject(new WikiError(reason));
  return { readPages: refuse, writePages: refuse };
}
