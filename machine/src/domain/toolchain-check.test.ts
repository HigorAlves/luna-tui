import { describe, expect, it } from "vitest";

import { toolchainProbe, toolchainWarnings, versionOf } from "./toolchain-check.ts";

describe("the version a tool prints", () => {
  it("is read from each tool's own words", () => {
    expect(versionOf("node", "v24.1.0")).toEqual([24, 1]);
    expect(versionOf("python", "Python 3.12.1")).toEqual([3, 12]);
    expect(versionOf("go", "go version go1.22.3 linux/arm64")).toEqual([1, 22]);
    expect(versionOf("rust", "rustc 1.99.0 (abc 2026-01-01)")).toEqual([1, 99]);
    expect(versionOf("java", 'openjdk version "21.0.2" 2024-01-16')).toEqual([21, 0]);
    expect(versionOf("java", 'java version "1.8.0_392"')).toEqual([8, 0]);
    expect(versionOf("ruby", "ruby 3.3.0 (2023-12-25 revision 5124f9ac75) [aarch64-linux]")).toEqual([3, 3]);
    expect(versionOf("pnpm", "10.4.1")).toEqual([10, 4]);
    expect(versionOf("node", "sh: node: not found")).toBeNull();
  });
});

describe("the probe", () => {
  it("is a script of fixed commands for the known tools only, never text from the repository", () => {
    const script = toolchainProbe({ node: "24", cargo: "1.99", "x; rm -rf /": "1", docker: "27" });
    expect(script).toContain("luna-tool:node=");
    expect(script).toContain("luna-tool:rust=");
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("docker");
    expect(toolchainProbe({})).toBe("");
  });
});

describe("toolchains against what the image has", () => {
  const out = "luna-tool:node=v22.3.0\nluna-tool:go=\nluna-tool:python=Python 3.12.1\nluna-tool:pnpm=10.4.1\n";
  it("says nothing when the major, and the minor when given, match", () => {
    expect(toolchainWarnings({ node: "22", python: "3.12", pnpm: "10.4" }, out)).toEqual([]);
    expect(toolchainWarnings({ node: ">=22", python: "~3.12" }, out)).toEqual([]);
  });

  it("names the tool, the wanted and the found version on a mismatch", () => {
    expect(toolchainWarnings({ node: "24", python: "3.13" }, out)).toEqual([
      "toolchains node: the image has 22.3, luna.yaml wants 24",
      "toolchains python: the image has 3.12, luna.yaml wants 3.13",
    ]);
  });

  it("says a tool the image lacks is missing, and skips a tool it does not know", () => {
    expect(toolchainWarnings({ go: "1.22", mystery: "9" }, out)).toEqual(["toolchains go: the image has none, luna.yaml wants 1.22"]);
  });
});
