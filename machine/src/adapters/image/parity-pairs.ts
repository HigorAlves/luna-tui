import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { readRegularBytes } from "../fs/bounded.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_WIDTH = 4000;
const MAX_HEIGHT = 8000;
const GAP = 16;
const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PairResult {
  /** The frame | build (| diff) composite, or null when an input could not be read. */
  pair: string | null;
  diff: string | null;
  /** Changed pixels over all pixels; null when the sizes differ or there is no pair. */
  diffRatio: number | null;
  note?: string;
}

const none = (note: string): PairResult => ({ pair: null, diff: null, diffRatio: null, note });

/** Reads a PNG within the caps; the size is read from the header before any pixel is decoded, so a small file that inflates huge is refused. */
async function load(path: string, label: string): Promise<{ png: PNG } | { note: string }> {
  let bytes: Buffer;
  try {
    bytes = await readRegularBytes(path, MAX_BYTES);
  } catch (e) {
    return { note: `${label} unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(MAGIC)) return { note: `${label} is not a PNG` };
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width > MAX_WIDTH || height > MAX_HEIGHT) return { note: `${label} is ${width}x${height}, over the ${MAX_WIDTH}x${MAX_HEIGHT} cap` };
  try {
    return { png: PNG.sync.read(bytes) };
  } catch {
    return { note: `${label} is not a PNG that can be read` };
  }
}

/** Puts the Figma render and the browser capture side by side, with a pixel diff beside them when the sizes match. The diff is an aid for the reviewer, never a verdict. Nothing throws. */
export async function pairImages(input: { render: string; capture: string; outDir: string; name: string }): Promise<PairResult> {
  if (!NAME.test(input.name)) return none("name must match [A-Za-z0-9_-]{1,80}");
  try {
    const a = await load(input.render, "frame");
    if ("note" in a) return none(a.note);
    const b = await load(input.capture, "build");
    if ("note" in b) return none(b.note);
    const frame = a.png;
    const build = b.png;
    const same = frame.width === build.width && frame.height === build.height;
    const panels = same ? 3 : 2;
    const height = Math.max(frame.height, build.height);
    const out = new PNG({ width: frame.width + build.width + (same ? frame.width : 0) + GAP * (panels - 1), height });
    out.data.fill(255);
    PNG.bitblt(frame, out, 0, 0, frame.width, frame.height, 0, 0);
    PNG.bitblt(build, out, 0, 0, build.width, build.height, frame.width + GAP, 0);
    const pair = join(input.outDir, `${input.name}.pair.png`);
    let diff: string | null = null;
    let diffRatio: number | null = null;
    let note: string | undefined;
    if (same) {
      const d = new PNG({ width: frame.width, height: frame.height });
      const changed = pixelmatch(frame.data, build.data, d.data, frame.width, frame.height, { threshold: 0.1 });
      diffRatio = changed / (frame.width * frame.height);
      PNG.bitblt(d, out, 0, 0, d.width, d.height, frame.width + build.width + GAP * 2, 0);
      diff = join(input.outDir, `${input.name}.diff.png`);
      await writeFile(diff, PNG.sync.write(d), { mode: 0o644 });
    } else {
      note = `sizes differ: frame ${frame.width}x${frame.height}, build ${build.width}x${build.height}`;
    }
    await writeFile(pair, PNG.sync.write(out), { mode: 0o644 });
    return { pair, diff, diffRatio, ...(note ? { note } : {}) };
  } catch (e) {
    return none(`pairing failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
