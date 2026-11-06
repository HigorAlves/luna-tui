// A repository's scoped secrets, from `~/.config/hardness/secrets/<repoSlug>/<NAME>`, beside the engines' credentials. Each file is read without
// following a link, capped at 64 KB, one trailing newline removed. A file readable by group or others, a link, or shorter than 8 characters is refused.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { secretNameProblem } from "@hardness/contracts";

import type { MissingSecret, SecretStore } from "../../application/secrets.ts";
import { readRegularFile } from "../fs/bounded.ts";
import { repoSlug } from "../graph/slug.ts";
import { secretsDir } from "./credential.ts";

const CAP = 64 * 1024;
const MIN_LENGTH = 8;

export function repoSecrets(options: { home: string; env?: NodeJS.ProcessEnv }): SecretStore {
  const folder = (repoPath: string): string => join(secretsDir(options.home), "secrets", repoSlug(repoPath));
  return {
    folder,
    async load(repoPath, names) {
      const values: Record<string, string> = {};
      const missing: MissingSecret[] = [];
      for (const name of names) {
        const refuse = (reason: string) => void missing.push({ name, reason });
        const problem = secretNameProblem(name);
        if (problem) {
          refuse(problem);
          continue;
        }
        const path = join(folder(repoPath), name);
        try {
          const info = await lstat(path);
          if (!info.isFile()) {
            refuse("the file is a link or not a regular file");
            continue;
          }
          if ((info.mode & 0o077) !== 0) {
            refuse("the file is readable by group or others; chmod 600 it");
            continue;
          }
          const text = (await readRegularFile(path, CAP)).replace(/\n$/, "");
          if (text.length < MIN_LENGTH) refuse(`the file holds fewer than ${MIN_LENGTH} characters`);
          else values[name] = text;
        } catch (error) {
          refuse((error as NodeJS.ErrnoException).code === "ENOENT" ? "there is no such file" : "the file could not be read");
        }
      }
      return { values, missing };
    },
  };
}
