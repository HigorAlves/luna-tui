import { describe, expect, it } from "vitest";

import { Observation } from "@hardness/contracts";

import { observe, type ObservedCall } from "./observe.ts";

const WORK = "/work/repo";
const bash = (command: string, output = "", ok = true): ObservedCall => ({ tool: "Bash", input: { command }, output, ok });
const run = (command: string, output = "", ok = true) => {
  const o = observe(bash(command, output, ok), { work: WORK });
  expect(Observation.safeParse(o).success).toBe(true);
  return o;
};

describe("observe: the acceptance case", () => {
  it("reads a missing pytest as a test run with a missing-command class and a failure fingerprint", () => {
    const o = observe({ tool: "Bash", input: { command: "pytest -q" }, output: "bash: pytest: command not found", ok: false }, { work: WORK });
    expect(o.intent).toBe("test");
    expect(o.errorClass).toBe("command_missing");
    expect(o.failure).toMatch(/^[0-9a-f]{10}$/);
    expect(Observation.parse(o)).toEqual(o);
  });
});

describe("observe: failure fingerprints", () => {
  it("gives two failing outputs that differ only in hex, digits and paths the same failure", () => {
    const a = run("pytest", "FAILED tests/a.py::t - AssertionError at /x/y.py:12 0xab", false);
    const b = run("pytest", "FAILED tests/a.py::t - AssertionError at /q/z.py:99 0x1", false);
    expect(a.failure).toMatch(/^[0-9a-f]{10}$/);
    expect(a.failure).toBe(b.failure);
  });

  it("records no failure for a call that succeeded, whatever its output says", () => {
    expect(run("cat log.txt", "TypeError: x", true).failure).toBeUndefined();
  });

  it("records no failure for a failed call whose output has no error marker", () => {
    expect(run("false", "", false).failure).toBeUndefined();
  });
});

describe("observe: content tools", () => {
  const content = ["Read", "Grep", "Glob", "read", "grep", "glob"];
  it.each(content)("counts a %s result as an error only when the tool itself failed", (tool) => {
    const text = "TypeError: boom\nFAILED\nCommand not found";
    const fine = observe({ tool, input: { file_path: "a.ts", pattern: "x" }, output: text, ok: true }, { work: WORK });
    expect(fine.failure).toBeUndefined();
    expect(fine.errorClass).toBeUndefined();
    const bad = observe({ tool, input: { file_path: "a.ts", pattern: "x" }, output: text, ok: false }, { work: WORK });
    expect(bad.failure).toMatch(/^[0-9a-f]{10}$/);
    expect(Observation.safeParse(fine).success && Observation.safeParse(bad).success).toBe(true);
  });
});

describe("observe: edits", () => {
  it("names the target of Write and Edit as a repo-relative path and drops one outside the worktree", () => {
    const w = observe({ tool: "Write", input: { file_path: "/work/repo/src/a.ts" }, output: "", ok: true }, { work: WORK });
    expect(w.edits).toEqual(["src/a.ts"]);
    const e = observe({ tool: "edit", input: { path: "src/b.ts" }, output: "", ok: true }, { work: WORK });
    expect(e.edits).toEqual(["src/b.ts"]);
    const out = observe({ tool: "Edit", input: { file_path: "/etc/hosts" }, output: "", ok: true }, { work: WORK });
    expect(out.edits).toBeUndefined();
    const up = observe({ tool: "Edit", input: { file_path: "../other/x.ts" }, output: "", ok: true }, { work: WORK });
    expect(up.edits).toBeUndefined();
  });

  it("names the targets of sed -i, > redirects and tee as repo-relative paths", () => {
    expect(run("sed -i s/a/b/ src/a.ts").edits).toEqual(["src/a.ts"]);
    expect(run("echo x > /work/repo/src/b.ts").edits).toEqual(["src/b.ts"]);
    expect(run("echo x | tee ./src/c.ts").edits).toEqual(["src/c.ts"]);
  });

  it("drops a shell edit target outside the worktree", () => {
    expect(run("echo x > /home/other/a.ts").edits).toBeUndefined();
    expect(run("sed -i s/a/b/ ../x/a.ts").edits).toBeUndefined();
  });

  it("keeps at most 20 edits of at most 300 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join(" ");
    expect(run(`sed -i s/a/b/ ${many}`).edits).toHaveLength(20);
    expect(run(`sed -i s/a/b/ ${"d/".repeat(200)}a.ts`).edits).toBeUndefined();
  });
});

describe("observe: form", () => {
  it("holds only the allowed characters, at most 120", () => {
    const o = run("FOO=$(rm -rf x) cd 'we ird' && pytest `id` ; echo", "", true);
    if (o.form !== undefined) expect(o.form).toMatch(/^[A-Za-z0-9 ._:=/@+-]*$/);
    const long = run(`cd ${"d".repeat(300)} && pytest`);
    expect(long.form?.length).toBeLessThanOrEqual(120);
    expect(long.form).toMatch(/^[A-Za-z0-9 ._:=/@+-]*$/);
  });

  it("spells the form of a plain test run", () => {
    expect(run("pytest -q tests/").form).toBe("pytest");
    expect(run("python -m pytest -x").form).toBe("python -m pytest");
  });

  it("carries an activation and a cd as a prefix", () => {
    expect(run("source .venv/bin/activate venv && pytest").form).toBe("source activate venv pytest");
    expect(run("cd sub && pytest").form).toBe("cd sub pytest");
  });
});

describe("observe: one intent per row of the table", () => {
  it.each([
    ["python --version", undefined, "python"],
    ["python -m pytest", "test", "python -m pytest"],
    ["python -m unittest discover", "test", "python -m unittest"],
    ["python -m mypy src", "build", "python -m mypy"],
    ["python3 runtests.py foo", "test", "python3 runtests.py"],
    ["python manage.py test app", "test", "python manage.py"],
    ["python manage.py migrate", "interpreter", "python"],
    ["python script.py", "interpreter", "python"],
    ["node app.js", "interpreter", "node"],
    ["pytest -q", "test", "pytest"],
    ["jest", "test", "jest"],
    ["./runtests.py", "test", "python runtests.py"],
    ["bin/test", "test", "python bin/test"],
    ["make test", "test", "make test"],
    ["cargo test", "test", "cargo test"],
    ["go test ./...", "test", "go test"],
    ["npm run test", "test", "npm run test"],
    ["npm run test:unit", "test", "npm run test:unit"],
    ["yarn test", "test", "yarn test"],
    ["pnpm test", "test", "pnpm test"],
    ["npm run build", "build", "npm run build"],
    ["npm run lint", "build", "npm run lint"],
    ["cargo build", "build", "cargo build"],
    ["tsc --noEmit", "build", "tsc"],
    ["eslint .", "build", "eslint"],
    ["which pytest", undefined, "which"],
    ["curl -s https://example.com/x", "fetch", "curl"],
    ["git clone https://github.com/a/b", "fetch", "git clone"],
    ["git remote -v", "vcs", "git remote"],
    ["git branch -a", "vcs", "git branch"],
    ["git status", undefined, undefined],
    ["pip install requests", "fetch", "pip install"],
    ["npm ci", "fetch", "npm ci"],
    ["pip list", "package", "pip"],
    ["brew doctor", "package", "brew"],
    ["ls -la", undefined, undefined],
  ] as const)("reads %j as intent %s", (command, intent, form) => {
    const o = run(command);
    expect(o.intent).toBe(intent);
    expect(o.form).toBe(form);
  });

  it("counts npm run test and yarn test as test runs, and keeps upstream's gap: yarn run test is unclassified", () => {
    expect(run("npm run test").intent).toBe("test");
    expect(run("yarn test").intent).toBe("test");
    expect(run("yarn run test").intent).toBeUndefined();
  });

  it("reads through launchers, assignments and wrappers", () => {
    expect(run("FOO=1 uv run pytest").intent).toBe("test");
    expect(run("uv run pytest").form).toBe("uv run pytest");
    expect(run("npx vitest run").form).toBe("npx vitest");
    expect(run("sudo timeout 60 pytest").intent).toBe("test");
    expect(run("/bin/bash -lc 'pytest -q'").intent).toBe("test");
    expect(run("conda run -n env1 pytest").form).toBe("conda run -n env1 pytest");
    expect(run("uvx ruff check").form).toBe("uvx ruff");
  });

  it("takes the host of a fetch and drops a login from it", () => {
    expect(run("curl https://user:pw@example.com:8080/a").host).toBe("example.com:8080");
    expect(run("pytest").host).toBeUndefined();
  });

  it("takes the host of a web fetch tool call", () => {
    const o = observe({ tool: "WebFetch", input: { url: "https://docs.example.org/x?y=1" }, output: "", ok: true }, { work: WORK });
    expect(o.intent).toBe("fetch");
    expect(o.host).toBe("docs.example.org");
    const e = observe({ tool: "web_fetch", input: { url: "not a url" }, output: "", ok: false }, { work: WORK });
    expect(e.host).toBeUndefined();
  });
});

describe("observe: segments of one command", () => {
  it("does not split on a quoted separator or a single &", () => {
    expect(run(`echo "a && b" ; pytest`).intent).toBe("test");
    expect(run("sleep 1 & pytest").intent).toBeUndefined();
  });

  it("skips a heredoc body", () => {
    expect(run("cat <<EOF\npytest\nEOF\nnpm run build").intent).toBe("build");
  });

  it("reports the segment named by the error when a chain fails", () => {
    const o = run("npm run build && pytest -q", "bash: pytest: command not found", false);
    expect(o.intent).toBe("test");
    expect(o.errorClass).toBe("command_missing");
  });

  it("reports the last target of a failed chain whose error names none", () => {
    expect(run("pytest && npm run build", "usage: something", false).intent).toBe("build");
  });

  it("reports the first target of a chain that went through", () => {
    expect(run("npm run build && pytest", "3 passed in 0.1s", true).intent).toBe("build");
  });

  it("reports the first target when a chain failed without an environment error", () => {
    expect(run("npm run build && pytest", "FAILED x", false).intent).toBe("build");
  });

  it("attributes a network error to the fetch that names its host", () => {
    const o = run("pytest; curl https://a.example/x; curl https://b.example/y", "curl: (6) Could not resolve host: b.example", false);
    expect(o.intent).toBe("fetch");
    expect(o.errorClass).toBe("name_resolution");
    expect(o.host).toBe("b.example");
  });

  it("skips classification when the cd itself failed", () => {
    const o = run("cd nope && pytest", "bash: cd: nope: No such file or directory", false);
    expect(o.intent).toBeUndefined();
  });
});

describe("observe: tests ran", () => {
  it.each([
    ["pytest", "collected 3 items\n3 passed in 0.2s", true],
    ["pytest", "Ran 4 tests in 0.1s", true],
    ["go test ./...", "ok  \tpkg\t0.01s", true],
    ["cargo test", "test result: ok. 3 passed", true],
    ["rspec", "3 examples, 0 failures", true],
    ["pytest", "no tests ran in 0.01s", false],
    ["pytest", "", false],
  ])("reads %j with output %j as testsRan %s", (command, output, ran) => {
    expect(run(command, output).testsRan).toBe(ran);
  });

  it("leaves testsRan out of a call that ran no test", () => {
    expect(run("npm run build", "Ran 4 tests").testsRan).toBeUndefined();
  });
});

describe("observe: environment variables", () => {
  it("names the variable an output asks for", () => {
    const o = run("python app.py", "KeyError: set the environment variable 'API_TOKEN' first", false);
    expect(o.envVar).toBe("API_TOKEN");
  });

  it("names a variable a command sets, never its value", () => {
    const o = run("FOO_BAR=secretvalue pytest");
    expect(o.envVar).toBe("FOO_BAR");
    expect(JSON.stringify(o)).not.toContain("secretvalue");
  });
});

describe("observe: unknown tools and bad input", () => {
  it("gives an empty observation for a tool it does not read", () => {
    expect(observe({ tool: "mcp__x__y", input: { a: 1 }, output: "ok", ok: true }, { work: WORK })).toEqual({});
  });

  it("survives an input that is not an object", () => {
    expect(observe({ tool: "Bash", input: "pytest", output: "", ok: true }, { work: WORK })).toEqual({});
    expect(observe({ tool: "Write", input: null, output: "", ok: true }, { work: WORK })).toEqual({});
  });

  it("caps a huge output without failing", () => {
    const o = run("pytest", `${"x".repeat(100000)}\nTypeError: late`, false);
    expect(Observation.safeParse(o).success).toBe(true);
  });

  it("passes the contract for every shape above", () => {
    for (const c of ["", "   ", "&&", ";", "(", "cd", "cd ~ && ls", "git", "python -m", "npm run", "echo $(", "<<<"]) run(c, "x", false);
  });
});
