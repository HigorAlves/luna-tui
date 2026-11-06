// The only file `calibrate` may write: the printed report, to the path a person gave with `--out`. Without it nothing is written, and the tools
// change no config file, default, pack or record.
import { writeFileSync } from "node:fs";

export function writeReport(path: string | undefined, lines: string[]): string | null {
  if (!path) return null;
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}
