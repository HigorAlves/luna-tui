// Copies orc's factory contract (packs + both schemas) into contracts/fixtures/orc/ and
// records the orc commit they came from. The conformance tests in contracts/ and machine/
// run against these copies, so a change on either side of the seam fails a test here
// instead of a real task. Re-run after bumping orc: `pnpm vendor:orc` (ORC_PATH to point
// at a checkout elsewhere; defaults to a sibling ../orc, then ~/Developer/system/orc).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [process.env.ORC_PATH, join(root, "..", "orc"), join(process.env.HOME ?? "", "Developer", "system", "orc")].filter(Boolean);
const orc = candidates.find((p) => existsSync(join(p, "orc", "factory", "stages.json")));
if (!orc) {
  console.error(`vendor-orc: no orc checkout found (tried ${candidates.join(", ")}); set ORC_PATH`);
  process.exit(2);
}

const sha = execFileSync("git", ["-C", orc, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
const dest = join(root, "contracts", "fixtures", "orc");
mkdirSync(dest, { recursive: true });
const files = {
  "stages.json": join(orc, "orc", "factory", "stages.json"),
  "stage-input.json": join(orc, "orc", "factory", "schema", "stage-input.json"),
  "stage-output.json": join(orc, "orc", "factory", "schema", "stage-output.json"),
  "stage-output.example.json": join(orc, "scripts", "ci", "fixtures", "factory", "stage-output.example.json"),
  "stage-input.example.json": join(orc, "scripts", "ci", "fixtures", "factory", "stage-input.example.json"),
};
for (const [name, from] of Object.entries(files)) copyFileSync(from, join(dest, name));
writeFileSync(join(dest, "SHA"), `${sha}\n`);
console.log(`vendored orc ${sha} from ${orc} into contracts/fixtures/orc/`);
