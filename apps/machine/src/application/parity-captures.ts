// The capture intake (RFC 0013, phase 3): what `qa-capture` wrote under the QA packet's `parity/` folder is untrusted (the container wrote it), so each file is checked
// on the host before it is copied into the machine's own folder, the one mounted for the reviewer at /evidence/parity.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { CaptureTarget, type CapturePlan, type ParityCapture, StyleRow, captureKey } from "@hardness/contracts";
import { z } from "zod";

import { copyRegularFile, readRegularFile } from "../adapters/fs/bounded.ts";

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
/** The PNG magic, then the IHDR chunk's length and type (8 bytes), its width (4) and its height (4). */
const IHDR_END = 24;
const MOUNT = "/evidence/parity";
const Styles = z.array(StyleRow).max(300);

export interface Collected {
  captures: ParityCapture[];
  /** The planned targets with no usable capture. */
  missing: CapturePlan["targets"];
  notes: string[];
}

/** The first bytes of a regular file, opened without following a link and without blocking on a FIFO. */
async function head(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Takes in the captures the plan asked for: a regular, non-link file under `maxBytes` that starts with the PNG magic. Nothing outside `<qaDir>/parity` is read. */
export async function collectCaptures(qaDir: string, plan: CapturePlan, outDir: string, { maxBytes = 8 * 1024 * 1024, maxStyleBytes = 2 * 1024 * 1024 } = {}): Promise<Collected> {
  const result: Collected = { captures: [], missing: [], notes: [] };
  const root = await realpath(join(qaDir, "parity")).catch(() => null);
  for (const target of plan.targets) {
    // The key becomes a path: it is built from parts that were checked by pattern, even though the plan is the machine's own.
    if (!CaptureTarget.safeParse(target).success) {
      result.missing.push(target);
      result.notes.push(`${target.scenario}: not a valid capture target`);
      continue;
    }
    const key = captureKey(target);
    const from = join(qaDir, "parity", `${key}.png`);
    const to = join(outDir, `${key}.png`);
    const refuse = (why: string) => {
      result.missing.push(target);
      result.notes.push(`${key}: ${why}`);
    };
    // A linked folder on the way (`parity/S1 -> elsewhere`) would make the PNG and the styles below come from outside `<qaDir>/parity`.
    const folder = root === null ? null : await realpath(dirname(from)).catch(() => null);
    if (folder === null) {
      result.missing.push(target);
      continue;
    }
    if (folder !== root && !folder.startsWith(root + sep)) {
      refuse("its folder is outside the capture folder");
      continue;
    }
    const info = await lstat(from).catch(() => null);
    if (!info) {
      result.missing.push(target);
      continue;
    }
    if (!info.isFile()) {
      refuse("not a regular file");
      continue;
    }
    if (info.size > maxBytes) {
      refuse(`over the ${maxBytes} byte cap`);
      continue;
    }
    try {
      const header = await head(from, IHDR_END);
      if (!header.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        refuse("not a PNG");
        continue;
      }
      // The file name is the container's word for what it shows: the image's own width must agree with the viewport, or be a whole multiple of it (device pixel ratio).
      const width = header.length >= IHDR_END ? header.readUInt32BE(IHDR_END - 8) : 0;
      if (width === 0 || width % target.viewport.width !== 0) {
        refuse(`its width ${width} does not fit the viewport width ${target.viewport.width}`);
        continue;
      }
      await mkdir(dirname(to), { recursive: true });
      await copyRegularFile(from, to);
      // What was copied is checked again: the file may have grown between the check and the copy.
      if ((await stat(to)).size > maxBytes) {
        await rm(to, { force: true });
        refuse(`over the ${maxBytes} byte cap`);
        continue;
      }
      await chmod(to, 0o644);
    } catch (error) {
      await rm(to, { force: true });
      refuse(error instanceof Error && /regular file/.test(error.message) ? "not a regular file" : `could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // The styles are a help, not a condition: bad or absent ones keep the capture.
    let styles: string | null = null;
    let elements = 0;
    try {
      const text = await readRegularFile(join(qaDir, "parity", `${key}.styles.json`), maxStyleBytes);
      const parsed = Styles.safeParse(JSON.parse(text));
      if (parsed.success) {
        await writeFile(join(outDir, `${key}.styles.json`), text, { mode: 0o644 });
        styles = `${MOUNT}/${key}.styles.json`;
        elements = parsed.data.length;
      } else result.notes.push(`${key}: the styles did not match the format, kept without them`);
    } catch {
      // absent, a link, too big or not JSON: the capture stays, without styles
    }
    result.captures.push({ scenario: target.scenario, frame: target.frame, viewport: target.viewport.name, state: target.state, image: `${MOUNT}/${key}.png`, styles, elements });
  }
  return result;
}
