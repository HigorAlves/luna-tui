// Writes ~/.config/hardness/brain-tokens.json once (`pnpm brain-tokens`): one token per actor of the
// company brain (brain/policies). The `brain` compose service and the machine both read it.
// The folder is yours alone (0700). The file is 0644 so the server's own user, which is not yours,
// can read the one file the service mounts.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".config", "hardness");
const file = join(dir, "brain-tokens.json");
if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokens = Object.fromEntries(["owner", "luna-facts", "luna-memories", "luna-reader"].map((actor) => [actor, randomBytes(32).toString("hex")]));
  writeFileSync(file, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  chmodSync(file, 0o644);
  console.log(`wrote ${file}`);
}
