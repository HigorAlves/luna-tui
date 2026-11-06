// Where a pack's media go: a port, so the target is the repository's choice (`evidence.storage`) and an object store is one adapter away.
// `put` answers where the file now is, or null when this target keeps nothing (the media stay local copies); `has` says whether the target
// still lists a url it gave. Nothing here ever fetches a url taken from a pack.
export interface EvidenceStorage {
  put(input: { slug: string; name: string; path: string; contentType: string; /** The bytes to store when they are not the file's own (a text file after `redact`). */ data?: Buffer }): Promise<{ url: string; /** The target already had a file of that name: nothing was uploaded. */ reused?: boolean } | null>;
  has(slug: string, url: string): Promise<boolean>;
}

/** The fallback: uploads nothing, so every media entry stays a local copy. */
export const localStorage = (): EvidenceStorage => ({
  put: async () => null,
  has: async () => false,
});
