// The `release_asset` target: files become assets of the draft pre-release `luna-evidence` of the repository, through the GitHub port. The file is read
// through the bounded reader (no link followed, a regular file, the size cap) unless the caller hands the bytes.
import type { EvidenceStorage } from "../../application/evidence-storage.ts";
import { MAX_MEDIA_BYTES } from "../../application/evidence-store.ts";
import type { GitHub } from "../../application/github.ts";
import { readRegularBytes } from "../fs/bounded.ts";

export const EVIDENCE_TAG = "luna-evidence";

export function releaseAssetStorage(github: GitHub): EvidenceStorage {
  const releases = new Map<string, Promise<{ id: number }>>();
  const release = (slug: string) => {
    let found = releases.get(slug);
    if (!found) {
      found = github.ensureRelease(slug, EVIDENCE_TAG, { name: "Luna evidence", prerelease: true });
      releases.set(slug, found);
    }
    return found;
  };
  return {
    async put({ slug, name, path, contentType, data }) {
      const { id } = await release(slug);
      const existing = (await github.releaseAssets(slug, id)).find((a) => a.name === name);
      if (existing) return { url: existing.url, reused: true };
      return github.uploadReleaseAsset(slug, id, name, data ?? (await readRegularBytes(path, MAX_MEDIA_BYTES)), contentType);
    },
    async has(slug, url) {
      const { id } = await release(slug);
      return (await github.releaseAssets(slug, id)).some((a) => a.url === url);
    },
  };
}
