// The one file the calibrate tools write: the report they printed, to the path `--out` names. Nothing else is written by them: they
// change no config file, default, pack or record. The file is opened without following a link (a link at the path is refused), and its mode is
// set on every write, so a report left open by an earlier run is closed.
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";

import { stripUnsafe } from "./records.ts";

export function writeReport(path: string | undefined, lines: string[]): string | null {
  if (!path) return null;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${lines.map(stripUnsafe).join("\n")}\n`);
  } finally {
    closeSync(fd);
  }
  return path;
}
