// The path a fact takes from the container to a prompt, per family that needs the observer's newer signals: the events as the container writes
// them (a tool_call and a tool_result with its observation), `observedCalls`, `evidenceOf`, and `foldFacts` over the runs that confirm it.
import { describe, expect, it } from "vitest";

import { evidenceOf } from "./envfacts.ts";
import { type FactRecord, foldFacts } from "./lifecycle.ts";
import { observedCalls } from "./observe-run.ts";

/** One call as `events.jsonl` holds it: the call, then its result with the observation and whether the tool itself failed. */
const call = (tool: string, target: string, observation: unknown, ok = true): unknown[] => [
  { kind: "tool_call", payload: { tool, target, allowed: true } },
  { kind: "tool_result", payload: { id: "1", tool, ok, observation } },
];

/** The facts after a repository's runs, each run's evidence read against the facts kept so far. */
function learn(runs: unknown[][]): FactRecord[] {
  let facts: FactRecord[] = [];
  runs.forEach((events, i) => {
    const known = facts.map((f) => ({ family: f.family, key: f.key, text: f.text }));
    facts = foldFacts(facts, evidenceOf(observedCalls(events), { known }), { runId: `r${i}`, cardId: `c${i}` });
  });
  return facts;
}
const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

describe("arg repair, end to end", () => {
  const run = [
    ...call("Bash", "python runtests.py tests.app.test_x", { intent: "test", form: "python runtests.py", labels: ["tests.app.test_x"], labelErr: true, errorClass: "module_missing", failure: "0123456789" }, false),
    ...call("Bash", "python runtests.py app.test_x", { intent: "test", form: "python runtests.py", labels: ["app.test_x"], testsRan: true }),
  ];

  it("is a candidate after the first run and active, in upstream's words, after three", () => {
    expect(learn([run])[0]).toMatchObject({ family: "arg_repair", state: "candidate", confirmations: 1 });
    const [fact, ...rest] = learn(times(3, () => run));
    expect(rest).toEqual([]);
    expect(fact).toMatchObject({ family: "arg_repair", state: "active", text: "`python runtests.py` takes test labels without the `tests.` prefix (`app.test_x`, not `tests.app.test_x`)." });
  });

  it("is the dotted-labels fact for a pytest id the runner could not load", () => {
    const sep = [
      ...call("Bash", "python -m pytest tests.a::T::t", { intent: "test", form: "python -m pytest", labels: ["tests.a::T::t"], labelErr: true }, false),
      ...call("Bash", "python -m pytest tests.a.T.t", { intent: "test", form: "python -m pytest", labels: ["tests.a.T.t"], testsRan: true }),
    ];
    expect(learn(times(3, () => sep))[0]).toMatchObject({ state: "active", text: "`python -m pytest` takes dotted test labels (`module.Class.test`, not `module::Class::test`)." });
  });

  it("is not formed from a runner that could not start: a label error flag is what separates the two", () => {
    const missing = call("Bash", "python -m pytest tests.a", { intent: "test", form: "python -m pytest", labels: ["tests.a"], errorClass: "module_missing" }, false);
    expect(learn([missing, missing, missing]).filter((f) => f.family === "arg_repair")).toEqual([]);
  });
});

describe("env value, end to end", () => {
  const run = [
    ...call("Bash", "python -c 'import app'", { intent: "interpreter", form: "python", needs: ["APP_ENV"], failure: "0123456789" }, false),
    ...call("Bash", "APP_ENV=prod python -c 'import app'", { intent: "interpreter", form: "python", envVar: "APP_ENV", sets: { APP_ENV: "prod" }, failure: "0123456789" }, false),
    ...call("Bash", "APP_ENV=test python -c 'import app'", { intent: "interpreter", form: "python", envVar: "APP_ENV", sets: { APP_ENV: "test" } }),
  ];

  it("states the value that worked and the one that did not, once three runs confirm it", () => {
    expect(learn(times(2, () => run))[0]).toMatchObject({ family: "env_value", state: "candidate" });
    const [fact] = learn(times(3, () => run));
    expect(fact).toMatchObject({ family: "env_value", key: "APP_ENV", state: "active", text: "Code that imports the project needs `APP_ENV` set here: `APP_ENV=test` works, `prod` does not." });
  });

  it("does not take a value as working when the call that set it showed a failure despite its exit status", () => {
    const hidden = [
      ...call("Bash", "python -c 'import app'", { intent: "interpreter", form: "python", needs: ["APP_ENV"], failure: "0123456789" }, false),
      ...call("Bash", "APP_ENV=test python -c 'import app' | tail", { intent: "interpreter", form: "python", sets: { APP_ENV: "test" }, failure: "abcdef0123" }, true),
    ];
    expect(learn([hidden])).toEqual([]);
  });

  it("refuses a result that carries a credential's value, so no fact can name it", () => {
    const secret = call("Bash", "API_TOKEN=abc python app.py", { intent: "interpreter", form: "python", sets: { API_TOKEN: "abc" } });
    expect(observedCalls(secret)).toEqual([]);
  });
});

describe("empty probe, end to end", () => {
  it("states the checkout's lack of history, in upstream's words, after three runs that found nothing", () => {
    const run = call("Bash", "git remote -v", { intent: "vcs", form: "git remote", probe: "empty" });
    const [fact] = learn(times(3, () => run));
    expect(fact).toMatchObject({
      family: "empty_probe",
      state: "active",
      text: "This checkout has no git remote and no branches, tags or unreachable objects beyond HEAD; its history ends at the checked-out commit.",
    });
  });

  it("is contradicted by a probe that listed something", () => {
    const empty = call("Bash", "git remote -v", { intent: "vcs", form: "git remote", probe: "empty" });
    const hit = call("Bash", "git branch -a", { intent: "vcs", form: "git branch", probe: "hit" });
    const [fact] = learn([empty, empty, hit]);
    expect(fact?.state).toBe("retired");
  });
});
