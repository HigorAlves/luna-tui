import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const machineDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(join(machineDir, "runner", "Dockerfile"), "utf8");

describe("the runner image's downloads", () => {
  it("checks the standalone Python's sha256 for each architecture before unpacking it", () => {
    for (const sum of ["126343c54daff4068efc1ac269518d0cc202d57857794948103dd1454e8881be", "b48451865bde9a39e2f3e71d7fdcbf1f32615f50f24d78dc50d04ede6501cf81"]) expect(dockerfile).toContain(sum);
    expect(dockerfile.indexOf("sha256sum -c")).toBeGreaterThan(0);
    expect(dockerfile.indexOf("sha256sum -c")).toBeLessThan(dockerfile.indexOf("tar -xz -C /opt/luna"));
  });
});

describe("the egress proxy in the runner image", () => {
  it("is copied to /opt/luna/egress/proxy.ts, labelled, and part of the image's build key", () => {
    expect(dockerfile).toContain("COPY machine/runner/egress/proxy.ts /opt/luna/egress/proxy.ts");
    expect(dockerfile).toContain('LABEL dev.hardness.egress="1"');
    expect(dockerfile.indexOf("COPY machine/runner/egress/proxy.ts")).toBeLessThan(dockerfile.indexOf("chmod -R a+rX /opt/luna"));
    expect(readFileSync(join(machineDir, "runner", "build.sh"), "utf8")).toContain("machine/runner/egress");
  });

  it("is let into the build context, checked by check-layer.sh, and type-checked", () => {
    expect(readFileSync(join(machineDir, "..", ".dockerignore"), "utf8")).toContain("!machine/runner/egress");
    expect(readFileSync(join(machineDir, "runner", "check-layer.sh"), "utf8")).toContain("/opt/luna/egress/proxy.ts --check");
    expect(JSON.parse(readFileSync(join(machineDir, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")).include).toContain("runner/egress");
    expect(readFileSync(join(machineDir, "runner", "layer.md"), "utf8")).toContain("egress/proxy.ts");
  });
});
