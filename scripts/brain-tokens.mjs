// Writes ~/.config/hardness/brain-tokens.json once (`pnpm brain-tokens`): one token per actor of the
// company brain (brain/policies). The `brain` compose service and the machine both read it.
// The file is 0644: the server runs as its own user (uid 999 in the image), which is not yours, and compose mounts that one file
// into it. What keeps the file from other users of this host is the folder, so the folder is made 0700, also when it was already
// there: it is the same folder the setup keeps the other credentials in. A bind mount of the file does not go through the folder.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".config", "hardness");
const file = join(dir, "brain-tokens.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
if (!existsSync(file)) {
  const tokens = Object.fromEntries(["owner", "luna-facts", "luna-memories", "luna-reader"].map((actor) => [actor, randomBytes(32).toString("hex")]));
  writeFileSync(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  chmodSync(file, 0o644);
  console.log(`wrote ${file}`);
}
