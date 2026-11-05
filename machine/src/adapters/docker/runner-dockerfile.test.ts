import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runner", "Dockerfile"), "utf8");

describe("the runner image's downloads", () => {
  it("checks the standalone Python's sha256 for each architecture before unpacking it", () => {
    for (const sum of ["126343c54daff4068efc1ac269518d0cc202d57857794948103dd1454e8881be", "b48451865bde9a39e2f3e71d7fdcbf1f32615f50f24d78dc50d04ede6501cf81"]) expect(dockerfile).toContain(sum);
    expect(dockerfile.indexOf("sha256sum -c")).toBeGreaterThan(0);
    expect(dockerfile.indexOf("sha256sum -c")).toBeLessThan(dockerfile.indexOf("tar -xz -C /opt/luna"));
  });
});
