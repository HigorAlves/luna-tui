import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";

import { pairImages } from "./parity-pairs.ts";

const dir = mkdtempSync(join(tmpdir(), "pairs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const png = (name: string, w: number, h: number, paint: (x: number, y: number) => [number, number, number]) => {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  const path = join(dir, name);
  writeFileSync(path, PNG.sync.write(img));
  return path;
};

describe("pairImages", () => {
  it("lays frame, build and diff side by side and measures what changed", async () => {
    const frame = png("f.png", 40, 20, () => [26, 115, 232]);
    const build = png("b.png", 40, 20, (x) => (x < 10 ? [200, 0, 0] : [26, 115, 232]));
    const r = await pairImages({ render: frame, capture: build, outDir: dir, name: "S1-desktop-default" });
    const pair = PNG.sync.read(readFileSync(r.pair!));
    expect([pair.width, pair.height]).toEqual([40 * 3 + 32, 20]);
    expect(r.diffRatio).toBeCloseTo(0.25, 2);
    expect(r.diff).toMatch(/S1-desktop-default\.diff\.png$/);
    expect(PNG.sync.read(readFileSync(r.diff!)).width).toBe(40);
  });
  it("pairs different sizes without a diff, and says why", async () => {
    const r = await pairImages({ render: png("f2.png", 40, 20, () => [0, 0, 0]), capture: png("b2.png", 40, 60, () => [0, 0, 0]), outDir: dir, name: "x" });
    const pair = PNG.sync.read(readFileSync(r.pair!));
    expect([pair.width, pair.height]).toEqual([40 * 2 + 16, 60]);
    expect(r).toMatchObject({ diff: null, diffRatio: null, note: "sizes differ: frame 40x20, build 40x60" });
  });
  it("answers no pair for a file that is not a PNG", async () => {
    writeFileSync(join(dir, "bad.png"), "nope");
    expect(await pairImages({ render: join(dir, "bad.png"), capture: join(dir, "b.png"), outDir: dir, name: "y" })).toMatchObject({ pair: null, note: expect.stringMatching(/not a PNG/) });
  });
  it("answers no pair for a missing file, an oversize image or a bad name, and never throws", async () => {
    const ok = png("ok.png", 10, 10, () => [1, 2, 3]);
    expect(await pairImages({ render: join(dir, "nope.png"), capture: ok, outDir: dir, name: "z" })).toMatchObject({ pair: null, diff: null, diffRatio: null });
    const tall = png("tall.png", 10, 8001, () => [0, 0, 0]);
    expect(await pairImages({ render: tall, capture: ok, outDir: dir, name: "z" })).toMatchObject({ pair: null, note: expect.stringMatching(/4000x8000/) });
    expect(await pairImages({ render: ok, capture: ok, outDir: dir, name: "../evil" })).toMatchObject({ pair: null, note: expect.stringMatching(/name/) });
  });
  it("refuses a header pngjs would not honour: interlaced, a second IHDR, or over the pixel budget", async () => {
    const ok = png("ok2.png", 10, 10, () => [1, 2, 3]);
    const bytes = readFileSync(ok);
    const ihdr = bytes.subarray(8, 33);
    const withIhdr = (data: Buffer) => {
      const chunk = Buffer.from(ihdr);
      data.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(chunk.subarray(4, 21)), 21);
      return chunk;
    };
    const interlaced = Buffer.from(ihdr.subarray(8, 21));
    interlaced[12] = 1;
    writeFileSync(join(dir, "interlaced.png"), Buffer.concat([bytes.subarray(0, 8), withIhdr(interlaced), bytes.subarray(33)]));
    expect(await pairImages({ render: join(dir, "interlaced.png"), capture: ok, outDir: dir, name: "i" })).toMatchObject({ pair: null, note: "frame is interlaced" });
    const huge = Buffer.from(ihdr.subarray(8, 21));
    huge.writeUInt32BE(10000, 0);
    huge.writeUInt32BE(10000, 4);
    writeFileSync(join(dir, "twice.png"), Buffer.concat([bytes.subarray(0, 33), withIhdr(huge), bytes.subarray(33)]));
    expect(await pairImages({ render: ok, capture: join(dir, "twice.png"), outDir: dir, name: "t" })).toMatchObject({ pair: null, note: "build has more than one IHDR" });
    const big = Buffer.from(ihdr.subarray(8, 21));
    big.writeUInt32BE(4000, 0);
    big.writeUInt32BE(4001, 4);
    writeFileSync(join(dir, "big.png"), Buffer.concat([bytes.subarray(0, 8), withIhdr(big), bytes.subarray(33)]));
    expect(await pairImages({ render: join(dir, "big.png"), capture: ok, outDir: dir, name: "b" })).toMatchObject({ pair: null, note: expect.stringMatching(/16000000 pixels/) });
  });
});
