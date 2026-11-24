import { describe, expect, it } from "vitest";

import { releaseNotesText } from "./release-notes.ts";

const answer = {
  highlights: ["Reports export to CSV", "Faster board load"],
  sections: [
    { heading: "Fixes" as const, items: [{ text: "The login loop no longer repeats", prs: [41] }] },
    { heading: "Features" as const, items: [{ text: "Export a report as CSV", prs: [38, 40] }, { text: "A dark theme", prs: [] }] },
    { heading: "Fixes" as const, items: [{ text: "Resizing the board keeps its cards", prs: [42] }] },
    { heading: "Other" as const, items: [] },
  ],
  breaking: ["The `--json` flag is now `--format json`"],
};

describe("releaseNotesText", () => {
  it("writes the highlights, the breaking changes, then each kind in a fixed order with its PRs, merging a kind that came twice", () => {
    expect(releaseNotesText(answer, new Set([38, 40, 41, 42]))).toBe(
      [
        "## Highlights",
        "- Reports export to CSV",
        "- Faster board load",
        "",
        "## Breaking changes",
        "- The `--json` flag is now `--format json`",
        "",
        "## Features",
        "- Export a report as CSV (#38, #40)",
        "- A dark theme",
        "",
        "## Fixes",
        "- The login loop no longer repeats (#41)",
        "- Resizing the board keeps its cards (#42)",
        "",
      ].join("\n"),
    );
  });

  it("never names a PR the machine did not give: an unknown number is dropped from the line", () => {
    const text = releaseNotesText({ highlights: [], sections: [{ heading: "Security", items: [{ text: "Patch a leak", prs: [7, 99] }] }], breaking: [] }, new Set([7]));
    expect(text).toBe("## Security\n- Patch a leak (#7)\n");
  });

  it("flattens a multi-line text to one line, and says so when there is nothing to report", () => {
    expect(releaseNotesText({ highlights: [], sections: [{ heading: "Other", items: [{ text: "line one\n- line two", prs: [] }] }], breaking: [] }, new Set())).toBe("## Other\n- line one - line two\n");
    expect(releaseNotesText({ highlights: [], sections: [], breaking: [] }, new Set())).toBe("No user-facing changes in this release.\n");
  });
});
