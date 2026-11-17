// Writes ~/.config/hardness/brain-tokens.json (`pnpm brain-tokens`): one token per actor of the
// company brain (brain/policies). The `brain` compose service and the machine both read it.
// The file is 0644: the server runs as its own user (uid 999 in the image), which is not yours, and compose mounts that one file
// into it. What keeps the file from other users of this host is the folder, so the folder is made 0700, also when it was already
// there: it is the same folder the setup keeps the other credentials in. A bind mount of the file does not go through the folder.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".config", "hardness");
const file = join(dir, "brain-tokens.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
// One token per actor of brain/policies. A file from before an actor existed gets that actor's token added; no token is ever replaced.
const ACTORS = ["owner", "luna-facts", "luna-memories", "luna-reader", "luna-mcp"];
const held = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const missing = ACTORS.filter((actor) => typeof held[actor] !== "string" || held[actor] === "");
if (missing.length > 0) {
  const tokens = { ...held, ...Object.fromEntries(missing.map((actor) => [actor, randomBytes(32).toString("hex")])) };
  // Written beside the file and moved over it, so a reader never sees half a file.
  writeFileSync(`${file}.tmp`, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o644 });
  chmodSync(`${file}.tmp`, 0o644);
  renameSync(`${file}.tmp`, file);
  console.log(`wrote ${file}${existsSync(file) && Object.keys(held).length > 0 ? ` (added ${missing.join(", ")})` : ""}`);
}
