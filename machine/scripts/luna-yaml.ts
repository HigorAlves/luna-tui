// The disk side of `make luna-yaml` (scripts/setup/luna-yaml.sh); the rules are in
// src/domain/luna-config-answers.ts. Run with plain node:
//   node machine/scripts/luna-yaml.ts engines                       pack|default|engine,engine…
//   node machine/scripts/luna-yaml.ts dump --repo DIR               the repo's luna.yaml as path=value lines
//   node machine/scripts/luna-yaml.ts apply --repo DIR --answers F  the new file on stdout, warnings on stderr
// Exits 2 with the reason when the result is a file the machine would refuse.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { applyAnswers, choosableEngines, flattenLunaConfig, parseAnswers } from "../src/domain/luna-config-answers.ts";
import { CONFIG_FILE } from "../src/domain/luna-config.ts";
import { PolicyParseError } from "../src/domain/policy.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { repo: { type: "string" }, answers: { type: "string" } } });
const current = (): string | null => {
  if (!values.repo) throw new PolicyParseError("--repo is required");
  const file = join(values.repo, CONFIG_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

try {
  switch (positionals[0]) {
    case "engines":
      for (const { pack, default: def, engines } of choosableEngines()) console.log(`${pack}|${def}|${engines.join(",")}`);
      break;
    case "dump":
      for (const line of flattenLunaConfig(current())) console.log(line);
      break;
    case "apply": {
      if (!values.answers) throw new PolicyParseError("--answers is required");
      const { text, warnings } = applyAnswers(current(), parseAnswers(readFileSync(values.answers, "utf8")));
      for (const warning of warnings) console.error(`warning: ${warning}`);
      process.stdout.write(text);
      break;
    }
    default:
      console.error("usage: luna-yaml.ts engines | dump --repo DIR | apply --repo DIR --answers FILE");
      process.exit(1);
  }
} catch (error) {
  if (!(error instanceof PolicyParseError)) throw error;
  console.error(error.message);
  process.exit(2);
}
