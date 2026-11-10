import { describe, expect, it } from "vitest";

import { type Evidence, evidenceOf, factId } from "./envfacts.ts";
import type { ObservedCall } from "./observe-run.ts";

const call = (over: Partial<ObservedCall>): ObservedCall => ({ ok: true, ...over });
const missing = (form: string, intent: ObservedCall["intent"] = "test", errorClass = "command_missing") => call({ intent, form, errorClass, ok: false });
const ran = (form: string, intent: ObservedCall["intent"] = "test") => call({ intent, form, ...(intent === "test" ? { testsRan: true } : {}) });
const only = (evidence: Evidence[], family: Evidence["family"]) => evidence.filter((e) => e.family === family);

describe("factId", () => {
  it("is a stable hash of the family and the key", () => {
    expect(factId("form_repair", "test:pytest")).toMatch(/^[0-9a-f]{12}$/);
    expect(factId("form_repair", "test:pytest")).toBe(factId("form_repair", "test:pytest"));
    expect(factId("absent_tool", "pytest")).not.toBe(factId("form_repair", "pytest"));
  });
});

describe("form repair", () => {
  it("states a command that failed as missing and the form that then worked", () => {
    const evidence = evidenceOf([missing("pytest"), ran("python -m pytest")]);
    expect(evidence).toEqual([
      { family: "form_repair", key: "test:pytest", text: "`pytest …` fails here with command not found; `python -m pytest …` works.", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("puts a working form that changes directory in a subshell, and names the error it saw", () => {
    const [fact] = evidenceOf([missing("python runtests.py", "test", "script_missing"), ran("cd tests python runtests.py")]);
    // The observer's charset has no `&`, so it writes `cd tests && python runtests.py` as `cd tests python runtests.py`; the text puts the `&&` back.
    expect(fact?.text).toBe("`python runtests.py …` fails here with a file-not-found error; `(cd tests && python runtests.py …)` works.");
  });

  it("prefers a working form that does not change directory", () => {
    const [fact] = evidenceOf([missing("pytest"), ran("cd app python -m pytest"), ran("python -m pytest")]);
    expect(fact?.text).toContain("`python -m pytest …` works.");
  });

  it("names a usage error, a permission error and a module error as upstream does", () => {
    expect(evidenceOf([missing("ruff", "build", "usage_error"), ran("python -m ruff", "build")])[0]?.text).toBe("`ruff …` fails here with a usage error; `python -m ruff …` works.");
    expect(evidenceOf([missing("python", "interpreter", "module_missing"), ran("conda run -n app python", "interpreter")])[0]?.text).toBe("`python …` fails here with ModuleNotFoundError; `conda run -n app python …` works.");
  });

  it("reads a failing interpreter or package tool only when its form is bare", () => {
    expect(evidenceOf([missing("conda run -n x python", "interpreter", "module_missing"), ran("python3", "interpreter")])).toEqual([]);
    expect(evidenceOf([missing("pip", "package"), ran("python -m pip", "package")])).toEqual([]);
    expect(only(evidenceOf([missing("pip", "package"), ran("uv run pip", "package")]), "form_repair")).toHaveLength(1);
  });

  it("needs the working form to come later, to need no variable and, for tests, to run the tests", () => {
    const repairs = (calls: ObservedCall[]) => only(evidenceOf(calls), "form_repair");
    expect(repairs([ran("python -m pytest"), missing("pytest")])).toEqual([]);
    expect(repairs([missing("pytest"), call({ intent: "test", form: "python -m pytest", testsRan: true, envVar: "DJANGO_SETTINGS_MODULE" })])).toEqual([]);
    expect(repairs([missing("pytest"), call({ intent: "test", form: "python -m pytest" })])).toEqual([]);
  });

  it("for a build, needs the two forms to share a word besides the runners", () => {
    expect(only(evidenceOf([missing("eslint", "build"), ran("npx eslint", "build")]), "form_repair")).toHaveLength(1);
    expect(only(evidenceOf([missing("eslint", "build"), ran("make lint", "build")]), "form_repair")).toEqual([]);
  });

  it("confirms a known fact when its form fails again, and counts it fired", () => {
    const known = [{ family: "form_repair" as const, key: "test:pytest", text: "`pytest …` fails here with command not found; `python -m pytest …` works." }];
    const [fact] = evidenceOf([missing("pytest")], { known });
    expect(fact).toMatchObject({ key: "test:pytest", confirms: true, contradicts: false, exercised: true, fired: true, text: "" });
  });

  it("counts an injected fact as fired when its working form ran and the old form did not, and confirms it", () => {
    const known = [{ family: "form_repair" as const, key: "test:pytest", text: "`pytest …` fails here with command not found; `python -m pytest …` works." }];
    const injected = new Set([factId("form_repair", "test:pytest")]);
    expect(evidenceOf([ran("python -m pytest")], { known, injected })[0]).toMatchObject({ confirms: true, fired: true });
    expect(evidenceOf([ran("python -m pytest")], { known })[0]).toMatchObject({ confirms: true, fired: false });
  });

  it("contradicts a known fact whose old form now runs the tests, and is exercised but quiet when the intent was seen without either", () => {
    const known = [{ family: "form_repair" as const, key: "test:pytest", text: "`pytest …` fails here with command not found; `python -m pytest …` works." }];
    expect(evidenceOf([ran("pytest")], { known })[0]).toMatchObject({ confirms: false, contradicts: true, exercised: true, fired: false });
    expect(evidenceOf([ran("go test")], { known })[0]).toMatchObject({ confirms: false, contradicts: false, exercised: true, fired: false });
    expect(evidenceOf([ran("ls", "build")], { known })).toEqual([]);
  });

  it("does not contradict an interpreter or package fact: only a runner's form can say the old form works", () => {
    const known = [{ family: "form_repair" as const, key: "interpreter:python", text: "`python …` fails here with ModuleNotFoundError; `conda run -n app python …` works." }];
    expect(evidenceOf([ran("python", "interpreter")], { known })[0]).toMatchObject({ contradicts: false, confirms: false });
  });
});

describe("absent tool", () => {
  it("states a build or test tool that is not there, when no other way to run it worked", () => {
    const evidence = evidenceOf([missing("ruff", "build")]);
    expect(only(evidence, "absent_tool")).toEqual([
      { family: "absent_tool", key: "ruff", text: "`ruff …` fails here with command not found, and no other way to run it has worked.", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("leaves out a tool another form of which worked, and one that a form repair covers", () => {
    expect(only(evidenceOf([missing("ruff", "build"), ran("python -m ruff", "build")]), "absent_tool")).toEqual([]);
    expect(only(evidenceOf([missing("pytest"), ran("python -m pytest")]), "absent_tool")).toEqual([]);
  });

  it("leaves out a failure that is not a bare single word, or not a missing command", () => {
    expect(only(evidenceOf([missing("poetry run ruff", "build")]), "absent_tool")).toEqual([]);
    expect(only(evidenceOf([missing("ruff", "build", "usage_error")]), "absent_tool")).toEqual([]);
  });

  it("contradicts a known tool that ran, and counts an injected one as fired when the run tried that kind of command", () => {
    const known = [{ family: "absent_tool" as const, key: "ruff", text: "`ruff …` fails here with command not found, and no other way to run it has worked." }];
    expect(evidenceOf([ran("ruff", "build")], { known })[0]).toMatchObject({ confirms: false, contradicts: true, exercised: true });
    const injected = new Set([factId("absent_tool", "ruff")]);
    expect(evidenceOf([ran("make lint", "build")], { known, injected })[0]).toMatchObject({ confirms: true, contradicts: false, fired: true });
    expect(evidenceOf([ran("make lint", "build")], { known })).toEqual([]);
  });
});

describe("boundary", () => {
  const refused = (host: string) => call({ intent: "fetch", host, errorClass: "name_resolution", ok: false });

  it("states the hosts that refused a fetch, the three that refused most", () => {
    const evidence = evidenceOf([refused("a.example"), refused("b.example"), refused("a.example"), refused("c.example"), refused("d.example"), refused("b.example"), refused("a.example")]);
    expect(only(evidence, "boundary")).toEqual([
      { family: "boundary", key: "fetch_remote", text: "Outbound connections to a.example, b.example and c.example are refused here; nothing can be fetched from them.", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("reads a connection refused and an unreachable network as refused too, and names one host plainly", () => {
    const [fact] = evidenceOf([call({ intent: "fetch", host: "registry.example:8080", errorClass: "connection_refused", ok: false }), call({ intent: "fetch", host: "registry.example:8080", errorClass: "unreachable", ok: false })]);
    expect(fact?.text).toBe("Outbound connections to registry.example:8080 are refused here; nothing can be fetched from them.");
  });

  it("contradicts the known fact when a fetch to one of its hosts worked, and does nothing for a host it never named", () => {
    const known = [{ family: "boundary" as const, key: "fetch_remote", text: "Outbound connections to a.example and b.example are refused here; nothing can be fetched from them." }];
    expect(evidenceOf([call({ intent: "fetch", host: "b.example" })], { known })[0]).toMatchObject({ confirms: false, contradicts: true, exercised: true, fired: false });
    expect(evidenceOf([call({ intent: "fetch", host: "other.example" })], { known })[0]).toMatchObject({ confirms: false, contradicts: false, exercised: true });
  });

  it("drops a host that is not a host name", () => {
    expect(only(evidenceOf([refused("a b")]), "boundary")).toEqual([]);
  });
});

describe("arg repair", () => {
  const run = (labels: string[], labelErr = false) => call({ intent: "test", form: "python runtests.py", labels, labelErr, testsRan: true, ok: !labelErr });

  it("states that a runner takes dotted labels when a `::` label failed and its dotted form loaded", () => {
    const evidence = evidenceOf([run(["app::Case::test_x"], true), run(["app.Case.test_x"])]);
    expect(only(evidence, "arg_repair")).toEqual([
      { family: "arg_repair", key: "python runtests.py:sep:::", text: "`python runtests.py` takes dotted test labels (`module.Class.test`, not `module::Class::test`).", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("states the prefix a runner does not want, with the shortest example", () => {
    const evidence = evidenceOf([run(["tests.app.test_x"], true), run(["app.test_x"]), run(["tests.app.test_y.deep"], true), run(["app.test_y"])]);
    expect(only(evidence, "arg_repair")[0]?.text).toBe("`python runtests.py` takes test labels without the `tests.` prefix (`app.test_x`, not `tests.app.test_x`).");
  });

  it("contradicts a known fact whose bad label loaded, and confirms one whose good label loaded", () => {
    const known = [{ family: "arg_repair" as const, key: "python runtests.py:strip:tests.", text: "x" }];
    expect(evidenceOf([run(["tests.app.test_x"])], { known })[0]).toMatchObject({ contradicts: true, confirms: false });
    expect(evidenceOf([run(["app.test_x"])], { known })[0]).toMatchObject({ contradicts: false, confirms: true, exercised: true, fired: false });
    expect(evidenceOf([run(["app.test_x"])], { known, injected: new Set([factId("arg_repair", "python runtests.py:strip:tests.")]) })[0]).toMatchObject({ fired: true });
  });

  it("finds nothing in a run the observer gave no labels for", () => {
    expect(evidenceOf([call({ intent: "test", form: "pytest", testsRan: true })])).toEqual([]);
  });
});

describe("env value", () => {
  it("states the value that made code that asked for a variable work, and the one that did not", () => {
    const evidence = evidenceOf([
      call({ intent: "test", form: "python -m pytest", needs: ["DJANGO_SETTINGS_MODULE"], ok: false }),
      call({ intent: "test", form: "python -m pytest", sets: { DJANGO_SETTINGS_MODULE: "wrong.settings" }, ok: false }),
      call({ intent: "test", form: "python -m pytest", sets: { DJANGO_SETTINGS_MODULE: "app.settings" } }),
    ]);
    expect(only(evidence, "env_value")).toEqual([
      { family: "env_value", key: "DJANGO_SETTINGS_MODULE", text: "Code that imports the project needs `DJANGO_SETTINGS_MODULE` set here: `DJANGO_SETTINGS_MODULE=app.settings` works, `wrong.settings` does not.", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("leaves the bad clause out when no bad value was tried", () => {
    const [fact] = evidenceOf([call({ needs: ["APP_ENV"], ok: false }), call({ sets: { APP_ENV: "test" } })]);
    expect(fact?.text).toBe("Code that imports the project needs `APP_ENV` set here: `APP_ENV=test` works.");
  });

  it("contradicts a known fact whose value was set and the variable was still asked for", () => {
    const known = [{ family: "env_value" as const, key: "APP_ENV", text: "Code that imports the project needs `APP_ENV` set here: `APP_ENV=test` works." }];
    expect(evidenceOf([call({ needs: ["APP_ENV"], sets: { APP_ENV: "test" }, ok: false })], { known })[0]).toMatchObject({ contradicts: true, confirms: false });
    expect(evidenceOf([call({ sets: { APP_ENV: "test" } })], { known, injected: new Set([factId("env_value", "APP_ENV")]) })[0]).toMatchObject({ confirms: true, fired: true, exercised: true });
  });

  it("refuses a variable name or a value outside the safe shapes", () => {
    expect(evidenceOf([call({ needs: ["bad name"], ok: false }), call({ sets: { "bad name": "x" } })])).toEqual([]);
    expect(evidenceOf([call({ needs: ["APP_ENV"], ok: false }), call({ sets: { APP_ENV: "a b;c" } })])).toEqual([]);
  });
});

describe("empty probe", () => {
  it("states that the history ends at the checked-out commit once a probe found nothing", () => {
    const evidence = evidenceOf([call({ intent: "vcs", form: "git remote", probe: "empty" }), call({ intent: "vcs", form: "git branch", probe: "empty" })]);
    expect(only(evidence, "empty_probe")).toEqual([
      { family: "empty_probe", key: "vcs_refs", text: "This checkout has no git remote and no branches, tags or unreachable objects beyond HEAD; its history ends at the checked-out commit.", confirms: true, contradicts: false, exercised: true, fired: true },
    ]);
  });

  it("contradicts at once when a probe listed anything", () => {
    expect(evidenceOf([call({ intent: "vcs", form: "git remote", probe: "hit" })])[0]).toMatchObject({ contradicts: true, confirms: false });
  });

  it("finds nothing in a probe whose answer the observer did not give", () => {
    expect(evidenceOf([call({ intent: "vcs", form: "git remote" })])).toEqual([]);
  });
});

describe("what a rendered fact may hold", () => {
  it("drops a candidate whose spelling is not in the safe charset", () => {
    expect(evidenceOf([missing("pytest $(id)"), ran("python -m pytest")])).toEqual([]);
    expect(only(evidenceOf([missing("pytest"), ran("python -m pytest `id`")]), "form_repair")).toEqual([]);
    expect(evidenceOf([missing("p".repeat(121)), ran("python -m pytest")])).toEqual([]);
  });

  it("drops a candidate whose spelling is shaped like a secret", () => {
    expect(evidenceOf([missing("sk-ant-abcdefghijklmnop"), ran("python -m pytest")])).toEqual([]);
    expect(only(evidenceOf([missing("pytest"), ran("python -m pytest --token=ghp_abcdefghijklmnopqrstuvwxyz0123")]), "form_repair")).toEqual([]);
  });

  it("gives nothing for a run with no calls", () => {
    expect(evidenceOf([])).toEqual([]);
  });
});

describe("a known form repair that changes directory", () => {
  it("is confirmed when its working form runs again", () => {
    const known = [{ family: "form_repair" as const, key: "test:python runtests.py", text: "`python runtests.py …` fails here with a file-not-found error; `(cd tests && python runtests.py …)` works." }];
    expect(evidenceOf([ran("cd tests python runtests.py")], { known })[0]).toMatchObject({ confirms: true, contradicts: false });
  });
});
