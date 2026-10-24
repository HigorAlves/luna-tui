import { describe, expect, it } from "vitest";

import { detectChecks } from "./detect.ts";

const fs = (files: Record<string, string>) => ({
  readFile: async (name: string) => files[name] ?? null,
  exists: async (name: string) => name in files,
});

describe("detectChecks", () => {
  it("reads test, lint and typecheck scripts and picks the manager from the lockfile", async () => {
    const found = await detectChecks(
      "/w",
      fs({
        "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc" } }),
        "pnpm-lock.yaml": "",
      }),
    );
    expect(found).toEqual({
      manager: "pnpm",
      test: ["pnpm", "run", "test"],
      lint: ["pnpm", "run", "lint"],
      typecheck: ["pnpm", "run", "typecheck"],
    });
  });

  it("accepts type-check, uses yarn for yarn.lock and npm otherwise", async () => {
    const yarn = await detectChecks(
      "/w",
      fs({ "package.json": JSON.stringify({ scripts: { "type-check": "tsc" } }), "yarn.lock": "" }),
    );
    expect(yarn).toEqual({ manager: "yarn", typecheck: ["yarn", "run", "type-check"] });
    const npm = await detectChecks("/w", fs({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }));
    expect(npm).toEqual({ manager: "npm", test: ["npm", "run", "test"] });
  });

  it("detects go modules", async () => {
    expect(await detectChecks("/w", fs({ "go.mod": "module x" }))).toEqual({
      manager: "go",
      test: ["go", "test", "./..."],
      lint: ["go", "vet", "./..."],
    });
  });

  it("detects pytest, with ruff only when configured", async () => {
    expect(await detectChecks("/w", fs({ "pytest.ini": "" }))).toEqual({ manager: "python", test: ["pytest", "-q"] });
    expect(await detectChecks("/w", fs({ "pyproject.toml": "[tool.ruff]\nline-length=100" }))).toEqual({
      manager: "python",
      test: ["pytest", "-q"],
      lint: ["ruff", "check", "."],
    });
  });

  it("falls back to Makefile test and lint targets", async () => {
    expect(await detectChecks("/w", fs({ Makefile: "test:\n\techo\nlint:\n\techo\n" }))).toEqual({
      manager: "make",
      test: ["make", "test"],
      lint: ["make", "lint"],
    });
  });

  it("returns nothing for an unknown project", async () => {
    expect(await detectChecks("/w", fs({ "README.md": "" }))).toEqual({ manager: null });
  });

  it("picks the manager from the lockfile and the test script", async () => {
    const pj = JSON.stringify({ scripts: { test: "x" } });
    expect(await detectChecks("/w", fs({ "package.json": pj }))).toMatchObject({ manager: "npm", test: ["npm", "run", "test"] });
    expect(await detectChecks("/w", fs({ "package.json": pj, "pnpm-lock.yaml": "" }))).toMatchObject({ manager: "pnpm", test: ["pnpm", "run", "test"] });
    expect(await detectChecks("/w", fs({ "package.json": pj, "yarn.lock": "" }))).toMatchObject({ manager: "yarn", test: ["yarn", "run", "test"] });
  });

  it("has no test command for a package.json without a test script", async () => {
    const found = await detectChecks("/w", fs({ "package.json": JSON.stringify({ scripts: { build: "x" } }) }));
    expect(found.test).toBeUndefined();
  });

  it("falls back to cargo test when there is a Cargo.toml and no package.json", async () => {
    expect(await detectChecks("/w", fs({ "Cargo.toml": '[package]\nname = "x"\n' }))).toEqual({
      manager: "cargo",
      test: ["cargo", "test"],
    });
  });
});
