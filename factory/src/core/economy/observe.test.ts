import { describe, expect, it } from "vitest";

import { knownForm, Observation } from "@hardness/contracts";

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

  it("names a variable a command sets", () => {
    const o = run("FOO_BAR=somevalue pytest");
    expect(o.envVar).toBe("FOO_BAR");
    expect(o.sets).toEqual({ FOO_BAR: "somevalue" });
  });

  it("never gives the value of a credential's name, nor a value outside the safe charset", () => {
    const o = run("FOO_TOKEN=secretvalue BAR_BAZ=$(cat /etc/passwd) pytest");
    expect(JSON.stringify(o)).not.toContain("secretvalue");
    expect(JSON.stringify(o)).not.toContain("passwd");
  });
});

describe("observe: test labels", () => {
  it("names the labels a runner was given after its own token", () => {
    expect(run("python -m pytest tests/test_a.py::TestX::test_y -q", "3 passed in 0.1s").labels).toEqual(["tests/test_a.py::TestX::test_y"]);
    expect(run("python runtests.py tests.app.test_x", "Ran 1 test").labels).toEqual(["tests.app.test_x"]);
  });

  it("does not take the value of an option for a label, nor a redirect target", () => {
    expect(run("pytest -k smoke tests/a.py > out.txt 2>&1", "1 passed in 1s").labels).toEqual(["tests/a.py"]);
    expect(run("pytest -k smoke", "1 passed in 1s").labels).toBeUndefined();
  });

  it("gives no labels to a runner that was given none, nor to a command that is not a test", () => {
    expect(run("pytest").labels).toBeUndefined();
    expect(run("npm run build src/a.ts").labels).toBeUndefined();
  });

  it("keeps at most five labels", () => {
    const o = run("pytest a/1.py a/2.py a/3.py a/4.py a/5.py a/6.py", "6 passed in 1s");
    expect(o.labels).toEqual(["a/1.py", "a/2.py", "a/3.py", "a/4.py", "a/5.py"]);
  });

  it("flags a label the runner could not load, by its own message or by the module it names", () => {
    expect(run("python runtests.py tests.app.test_x", "ImportError: Failed to import test module: tests.app", false).labelErr).toBe(true);
    expect(run("python runtests.py tests.app.test_x", "ModuleNotFoundError: No module named 'tests'", false).labelErr).toBe(true);
    expect(run("python runtests.py tests.app.test_x", "ERROR: not found: tests/app", false).labelErr).toBe(true);
  });

  it("does not flag a missing runner as a label error, nor a run that loaded its labels", () => {
    expect(run("python -m pytest tests/a.py", "No module named pytest", false).labelErr).toBeUndefined();
    expect(run("pytest tests/a.py", "1 passed in 1s").labelErr).toBeUndefined();
  });
});

describe("observe: variables a call needs and sets", () => {
  it("lists every variable the output asks for, sorted, at most five", () => {
    const out = "set the environment variable ZED_ONE\nset the environment variable ALPHA_TWO";
    expect(run("python app.py", out, false).needs).toEqual(["ALPHA_TWO", "ZED_ONE"]);
  });

  it("gives the value of a variable a command sets, inline, exported or in code", () => {
    expect(run("DJANGO_SETTINGS_MODULE=tests.settings pytest", "1 passed in 1s").sets).toEqual({ DJANGO_SETTINGS_MODULE: "tests.settings" });
    expect(run("export APP_ENV=test && pytest", "1 passed in 1s").sets).toEqual({ APP_ENV: "test" });
    expect(run(`python -c "import os; os.environ['APP_MODE'] = 'ci'; import app"`, "").sets).toEqual({ APP_MODE: "ci" });
  });

  it("never gives a variable whose name looks like a credential, and keeps its name only as envVar", () => {
    const names = ["API_TOKEN", "GITHUB_SECRET", "DB_PASSWORD", "DB_PASSWD", "OPENAI_API_KEY", "AWS_CREDENTIAL", "BASIC_AUTH", "SESSION_ID", "MY_COOKIE", "api_key_x"];
    for (const name of names) {
      const o = run(`${name}=abc123 pytest`, "1 passed in 1s");
      expect(o.sets).toBeUndefined();
      expect(JSON.stringify(o)).not.toContain("abc123");
    }
    const mixed = run("API_TOKEN=abc123 APP_ENV=test pytest", "1 passed in 1s");
    expect(mixed.sets).toEqual({ APP_ENV: "test" });
  });

  it("drops a value outside the safe charset or longer than 60", () => {
    expect(run("APP_ENV=$(whoami) pytest").sets).toBeUndefined();
    expect(run(`APP_ENV=${"a".repeat(61)} pytest`).sets).toBeUndefined();
  });

  it("keeps at most five variables", () => {
    const o = run("AA_1=a BB_1=b CC_1=c DD_1=d EE_1=e FF_1=f pytest", "1 passed in 1s");
    expect(Object.keys(o.sets ?? {})).toHaveLength(5);
  });

  it("counts a call that shows a traceback despite its exit status as failed, so its values are not taken as working", () => {
    const o = run("APP_ENV=bad python app.py | tee log", "Traceback (most recent call last):\n  File x\nValueError: no", true);
    expect(o.failure).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("observe: a version control probe", () => {
  it("is a hit when the output lists what the probe looks for", () => {
    expect(run("git remote -v", "origin\thttps://x/y.git (fetch)\norigin\thttps://x/y.git (push)").probe).toBe("hit");
    expect(run("git branch -a", "* main\n  remotes/origin/main").probe).toBe("hit");
    expect(run("git stash list", "stash@{0}: WIP on main").probe).toBe("hit");
  });

  it("is empty when the probe succeeded and listed nothing", () => {
    expect(run("git remote -v", "").probe).toBe("empty");
    expect(run("git branch -a", "* main").probe).toBe("empty");
    expect(run("git stash list", "").probe).toBe("empty");
  });

  it("says nothing when the call failed without a hit, or held other work", () => {
    expect(run("git remote -v", "fatal: not a git repository", false).probe).toBeUndefined();
    expect(run("git remote -v && npm run build", "").probe).toBeUndefined();
    expect(run("pytest").probe).toBeUndefined();
  });
});

describe("observe: a test run whose exit status is not the runner's", () => {
  const failing = "FAILED tests/a.py::t - AssertionError: x\n1 failed, 2 passed in 0.4s";

  it("records the failure of a piped test run that exited 0", () => {
    const o = run("npm test | tail -20", failing, true);
    expect(o.failure).toMatch(/^[0-9a-f]{10}$/);
    expect(o.testsRan).toBe(true);
  });

  it("does the same for || true, a reported status and a pipe to a filter", () => {
    for (const cmd of ["pytest || true", 'pytest; echo "exit=$?"', "pytest 2>&1 | grep -v warn", "bash -lc 'pytest | tail'"]) {
      expect(run(cmd, failing, true).failure, cmd).toMatch(/^[0-9a-f]{10}$/);
    }
  });

  it("fingerprints a run's own summary when no line holds an error marker", () => {
    expect(run("npx vitest run | tail", " Tests  2 failed | 3 passed (5)", true).failure).toMatch(/^[0-9a-f]{10}$/);
  });

  it("gives a repeated piped failure the same fingerprint as the unpiped one", () => {
    expect(run("pytest | tail", failing, true).failure).toBe(run("pytest", failing, false).failure);
  });

  it("records no failure when the summary says the run passed, even if the pipe failed", () => {
    expect(run("pytest | grep -q x", "3 passed in 0.2s", false).failure).toBeUndefined();
    expect(run("npm test | tail", "3 passed in 0.2s", true).failure).toBeUndefined();
  });

  it("lets the output markers decide when a hidden run has no summary", () => {
    expect(run("pytest | tail", "Traceback (most recent call last):\nValueError: x", true).failure).toMatch(/^[0-9a-f]{10}$/);
    expect(run("pytest | tail", "collecting...", true).failure).toBeUndefined();
  });

  it("keeps the reported status of a run followed by other commands, and of a covered one", () => {
    expect(run("pytest; git diff --stat", "FAILED x", true).failure).toBeUndefined();
    expect(run("cd app && pytest", "FAILED x", true).failure).toBeUndefined();
    expect(run("pytest", failing, true).failure).toBeUndefined();
  });

  it("keeps a content tool's text from counting as an error", () => {
    const o = observe({ tool: "Read", input: { file_path: "a.log" }, output: failing, ok: true }, { work: WORK });
    expect(o.failure).toBeUndefined();
  });

  it("keeps the failure of a tool that failed, test run or not", () => {
    expect(run("pytest", failing, false).failure).toMatch(/^[0-9a-f]{10}$/);
    expect(run("python x.py", "ValueError: x", false).failure).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("observe: a call known to have succeeded has no error class", () => {
  const tool = (name: string, input: unknown, output: string, ok = true) => observe({ tool: name, input, output, ok }, { work: WORK });

  it("gives a successful Write of a document that mentions a missing command no class", () => {
    const o = tool("Write", { file_path: "/work/repo/docs/setup.md" }, "bash: pytest: command not found", true);
    expect(o.errorClass).toBeUndefined();
    expect(o.failure).toBeUndefined();
  });

  it("gives a successful Agent result that mentions a missing module no class", () => {
    const o = tool("Agent", { prompt: "find it" }, "The log said: ModuleNotFoundError: No module named 'numpy'", true);
    expect(o.errorClass).toBeUndefined();
    expect(o.failure).toBeUndefined();
  });

  it("gives no class to Skill, MCP and WebFetch results that succeeded, whatever they say", () => {
    for (const name of ["Skill", "mcp__x__y", "WebFetch"]) {
      const o = tool(name, { url: "https://docs.example.org/" }, "Traceback (most recent call last):\nTypeError: x", true);
      expect(o.errorClass, name).toBeUndefined();
      expect(o.failure, name).toBeUndefined();
    }
  });

  it("gives a successful git log whose output holds a missing-command line no class", () => {
    const o = run("git log --oneline -5", "a1b2c3d fix: pytest: command not found in CI", true);
    expect(o.errorClass).toBeUndefined();
    expect(o.failure).toBeUndefined();
  });

  it("still reads a test run whose status a pipe replaced by its failing summary", () => {
    const o = run("npm test 2>&1 | tail -n 20", "FAIL src/a.test.ts\nAssertionError: expected 1 to be 2\nTests: 1 failed, 3 passed", true);
    expect(o.failure).toMatch(/^[0-9a-f]{10}$/);
  });

  it("classifies a command whose exit status does not cover it by its output's markers", () => {
    expect(run("pytest -q; git diff --stat", "bash: pytest: command not found", true).errorClass).toBeUndefined();
    expect(run("python3 run.py 2>&1 | tail -n 5","ModuleNotFoundError: No module named x", true).errorClass).toBe("module_missing");
  });

  it("classifies a tool that failed, a Read among them", () => {
    const read = tool("Read", { file_path: "a.log" }, "EACCES: permission denied, open 'a.log'", false);
    expect(read.errorClass).toBe("permission_denied");
    const agent = tool("Agent", { prompt: "x" }, "ModuleNotFoundError: No module named 'numpy'", false);
    expect(agent.errorClass).toBe("module_missing");
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

describe("observe: forms and the machine's grammar", () => {
  it("emits, for the commands of the fixtures above, only forms of a runnable intent that knownForm accepts", () => {
    const commands = [
      "python -m pytest", "python -m unittest discover", "python -m mypy src", "python3 runtests.py foo", "python manage.py test app", "python script.py", "node app.js",
      "pytest -q", "jest", "./runtests.py", "bin/test", "make test", "cargo test", "go test ./...", "npm run test", "npm run test:unit", "yarn test", "pnpm test",
      "npm run build", "npm run lint", "cargo build", "tsc --noEmit", "eslint .", "pip list", "brew doctor", "pytest -q tests/", "python -m pytest -x",
      "source .venv/bin/activate venv && pytest", "cd sub && pytest", "conda activate e1 && python -m pytest", "FOO=1 uv run pytest", "uv run pytest", "npx vitest run",
      "sudo timeout 60 pytest", "/bin/bash -lc 'pytest -q'", "conda run -n env1 pytest", "uvx ruff check", "poetry run pytest", "pipx run tox", "bundle exec rspec",
    ];
    for (const command of commands) {
      const o = run(command);
      if (o.form !== undefined && o.intent !== undefined && ["interpreter", "test", "build", "package"].includes(o.intent)) expect(knownForm(o.form), `${command} -> ${o.form}`).toBe(true);
    }
  });
});
