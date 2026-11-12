import { describe, expect, it } from "vitest";

import { shellEditTargets, shellRevertTargets } from "./shell-edits.ts";

describe("shellEditTargets", () => {
  it("names the file operands of sed -i, not the script", () => {
    expect(shellEditTargets("sed -i 's/a/b/' src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(shellEditTargets("sed -i.bak -e 's/a/b/' src/a.ts")).toEqual(["src/a.ts"]);
    expect(shellEditTargets("sed --in-place --expression=s/a/b/ src/a.ts")).toEqual(["src/a.ts"]);
  });

  it("does not count sed without -i", () => {
    expect(shellEditTargets("sed -n '1,5p' src/a.ts")).toEqual([]);
  });

  it("names the file operands of perl -pi", () => {
    expect(shellEditTargets("perl -pi -e 's/a/b/' lib/x.pl")).toEqual(["lib/x.pl"]);
  });

  it("counts a redirect to a source file as an edit, and ignores a log capture", () => {
    expect(shellEditTargets("echo hi > src/a.ts")).toEqual(["src/a.ts"]);
    expect(shellEditTargets("cat x >> notes.md")).toEqual(["notes.md"]);
    expect(shellEditTargets("pnpm test > out.log 2>&1")).toEqual([]);
    expect(shellEditTargets("echo hi 2> err.log")).toEqual([]);
  });

  it("does not take a quoted > for a redirect", () => {
    expect(shellEditTargets("echo '>' a.ts")).toEqual([]);
  });

  it("counts tee targets that look like source", () => {
    expect(shellEditTargets("echo x | tee -a src/a.ts run.txt")).toEqual(["src/a.ts"]);
  });

  it("reads the files named in an apply_patch heredoc", () => {
    const cmd = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch\nPATCH";
    expect(shellEditTargets(cmd)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reads writes from inline python", () => {
    expect(shellEditTargets(`python -c "open('src/a.py', 'w').write('x')"`)).toEqual(["src/a.py"]);
    expect(shellEditTargets(`python3 -c "from pathlib import Path; Path('src/b.py').write_text('x')"`)).toEqual(["src/b.py"]);
    expect(shellEditTargets(`python -c "open('src/a.py', 'r').read()"`)).toEqual([]);
  });

  it("resolves a python variable to the path it was given", () => {
    expect(shellEditTargets(`python -c "p = 'src/c.py'\nopen(p, 'w').write('x')"`)).toEqual(["src/c.py"]);
  });

  it("sees an edit after a chain operator, a newline or a wrapper", () => {
    expect(shellEditTargets("cd x && sudo sed -i s/a/b/ f.ts")).toEqual(["f.ts"]);
    expect(shellEditTargets("echo a;\nsed -i s/a/b/ f.ts")).toEqual(["f.ts"]);
    expect(shellEditTargets("FOO=1 env sed -i s/a/b/ f.ts")).toEqual(["f.ts"]);
    expect(shellEditTargets("bash -lc 'sed -i s/a/b/ f.ts'")).toEqual(["f.ts"]);
  });

  it("ignores scratch paths, pseudo-names and duplicates", () => {
    expect(shellEditTargets("echo a > /tmp/x.ts")).toEqual([]);
    expect(shellEditTargets("patch -p1 < fix.diff")).toEqual([]);
    expect(shellEditTargets("echo a > a.ts; echo b > a.ts")).toEqual(["a.ts"]);
  });

  it("drops a comment, and falls back line by line on an unbalanced quote", () => {
    expect(shellEditTargets("echo a # > a.ts")).toEqual([]);
    expect(shellEditTargets("echo 'oops\nsed -i s/a/b/ g.ts")).toEqual(["g.ts"]);
  });

  it("is empty for a blank command", () => {
    expect(shellEditTargets("   ")).toEqual([]);
  });
});

describe("shellRevertTargets", () => {
  it("names the paths git checkout -- and git restore put back", () => {
    expect(shellRevertTargets("git checkout -- src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(shellRevertTargets("git restore --staged src/a.ts")).toEqual(["src/a.ts"]);
    expect(shellRevertTargets("git status")).toEqual([]);
  });
});
