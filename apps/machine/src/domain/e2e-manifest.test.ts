import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { boundedArtifacts, manifestRows } from "./e2e-manifest.ts";

const scenarios = [{ id: "S1", title: "export downloads a file" }, { id: "S2", title: "empty report" }, { id: "S3", title: "large report" }];

describe("the browser run's manifest", () => {
  it("has one row per approved scenario by id: matched by the title the run copied or by the criterion id, with what was seen and the artifacts by name", () => {
    const rows = manifestRows(scenarios, [
      { text: "export downloads a file", result: "fail", note: "got a 500", evidence: ["export.png", "console.log"] },
      { text: "something else", criterion: "S3", result: "pass", evidence: [] },
    ], "the run's summary");
    expect(rows.map((r) => [r.scenario, r.result])).toEqual([["S1", "fail"], ["S2", "not_run"], ["S3", "pass"]]);
    expect(rows[0]).toMatchObject({ seen: "got a 500", artifacts: ["export.png", "console.log"] });
    expect(rows[1]).toMatchObject({ seen: "", artifacts: [] });
  });

  it("matches a row that opens with its scenario id, or copies the title but for case and spacing, and never gives one scenario's id row to another", () => {
    // The site card's run (2026-11-08): every row was "S25 <title>" with the criterion's text, and all three read not_run.
    const rows = manifestRows(scenarios, [
      { text: "S1 export downloads a file", criterion: "In a browser, …", result: "pass", evidence: [] },
      { text: "[S3]: large report renders", result: "fail", evidence: [] },
      { text: "S1 empty report", result: "fail", evidence: [] },
      { text: "  Empty  Report. ", result: "pass", evidence: [] },
    ], "");
    expect(rows.map((r) => [r.scenario, r.result])).toEqual([["S1", "pass"], ["S2", "pass"], ["S3", "fail"]]);
  });

  it("reads an artifact written as files/qa/<name> as that name", () => {
    const rows = manifestRows(scenarios, [{ text: "empty report", result: "fail", evidence: ["files/qa/a.png", "files/qa/sub/b.png"] }], "");
    expect(rows[1]!.artifacts).toEqual(["a.png", "files/qa/sub/b.png".slice("files/qa/".length)]);
  });

  it("reads a result it does not know as partial, and a row that is not an object as no row", () => {
    const rows = manifestRows(scenarios, [{ text: "empty report", result: "maybe", evidence: [] }, null, "x", 7], "");
    expect(rows[1]!.result).toBe("partial");
    expect(rows[0]!.result).toBe("not_run");
  });

  it("flattens and caps what was seen", () => {
    const [row] = manifestRows(scenarios, [{ text: "export downloads a file", result: "fail", note: `<b>x</b>\n${"y".repeat(2000)}`, evidence: [] }], "");
    expect(row!.seen).not.toContain("<b>");
    expect(row!.seen.length).toBeLessThanOrEqual(400);
  });
});

describe("the artifacts of a run", () => {
  it("keeps only plain-named regular files in the run's folder, and drops a link, a directory, a path and a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-"));
    writeFileSync(join(dir, "shot.png"), "x");
    mkdirSync(join(dir, "folder"));
    symlinkSync("/etc/hosts", join(dir, "link.png"));
    expect(await boundedArtifacts(["shot.png", "folder", "link.png", "../etc/passwd", "sub/shot.png", "gone.png"], dir)).toEqual(["shot.png"]);
  });

  it("drops everything when the run has no folder", async () => {
    expect(await boundedArtifacts(["shot.png"], null)).toEqual([]);
  });
});
