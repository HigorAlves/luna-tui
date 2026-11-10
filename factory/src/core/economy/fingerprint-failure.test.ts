import { describe, expect, it } from "vitest";

import { errorClassOf, failureSignature, isErrorOutput, splitLines } from "./fingerprint-failure.ts";

describe("isErrorOutput", () => {
  it.each([
    ["Traceback (most recent call last):\n  File x"],
    ["TypeError: x is not a function"],
    ["error: build failed"],
    ["1 FAILED"],
    ["assert 1 == 2"],
    ["java.lang.RuntimeException"],
    ["3 errors during collection"],
    ["# fail 2"],
    ["ok 1\nnot ok 3 - thing"],
    ["2 failing"],
    ["1 failure"],
    ["Failures: 2"],
    ["--- FAIL: TestX (0.00s)"],
    ["FAIL\tgithub.com/x/y\t0.1s"],
    ["ok  \tpkg\nFAIL"],
  ])("recognises %j as an error output", (text) => {
    expect(isErrorOutput(text)).toBe(true);
  });

  it("keeps the Go branch case-sensitive, so unittest's FAIL: line alone is not an error", () => {
    expect(isErrorOutput("FAIL: test_x (mod.T)")).toBe(false);
    expect(isErrorOutput("fail\tpkg")).toBe(false);
    expect(isErrorOutput("# fail 0")).toBe(false);
    expect(isErrorOutput("0 failures")).toBe(false);
    expect(isErrorOutput("all good")).toBe(false);
  });
});

describe("splitLines", () => {
  it("splits like Python's splitlines on \\r\\n, \\v, \\f, \\x85 and the Unicode separators", () => {
    expect(splitLines("a\r\nb\rc\vd\fe\u0085f\u2028g\u2029h\n")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("failureSignature", () => {
  it("gives two error lines that differ only in hex, digits and paths the same signature", () => {
    const a = failureSignature("ok\nTypeError: bad at /home/a/x.py:12 0xdeadbeef 77");
    const b = failureSignature("TypeError: bad at /tmp/zzz/y.py:99 0x1f 3");
    expect(a).toMatch(/^[0-9a-f]{10}$/);
    expect(a).toBe(b);
  });

  it("gives a different signature to a different error", () => {
    expect(failureSignature("TypeError: a")).not.toBe(failureSignature("ValueError: a"));
  });

  it("reads the first matching line only", () => {
    expect(failureSignature("noise\nTypeError: a\nValueError: b")).toBe(failureSignature("TypeError: a"));
  });

  it("is undefined for an empty text and for a text with no error line", () => {
    expect(failureSignature("")).toBeUndefined();
    expect(failureSignature("all green")).toBeUndefined();
  });

  it("falls back to a line the caller names when no line matches the error markers", () => {
    expect(failureSignature("bash: pytest: command not found")).toBeUndefined();
    expect(failureSignature("bash: pytest: command not found", /command not found/i)).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("errorClassOf", () => {
  it.each([
    ["ModuleNotFoundError: No module named 'x'", "module_missing"],
    ["Error: Cannot find module 'x'", "module_missing"],
    ["bash: ruff: command not found", "command_missing"],
    ["/bin/sh: 1: ruff: not found", "command_missing"],
    ["'ruff' is not recognized as an internal command", "command_missing"],
    ["python: can't open file 'runtests.py': [Errno 2] No such file or directory", "script_missing"],
    ["bash: ./x.sh: Permission denied", "permission_denied"],
    ["npm ERR! code EACCES", "permission_denied"],
    ["usage: pytest [options]", "usage_error"],
    ["pytest: error: unrecognized arguments: --x", "usage_error"],
    ["curl: (7) Failed to connect to localhost port 80", "connection_refused"],
    ["Error: connect ECONNREFUSED 127.0.0.1:80", "connection_refused"],
    ["curl: (6) Could not resolve host: x.invalid", "name_resolution"],
    ["getaddrinfo ENOTFOUND x", "name_resolution"],
    ["Network is unreachable", "unreachable"],
    ["Error: ETIMEDOUT", "unreachable"],
  ])("classifies %j as %s", (text, name) => {
    expect(errorClassOf(text)?.name).toBe(name);
  });

  it("names the first class in table order and gives the line that matched", () => {
    const hit = errorClassOf("noise\nbash: x: command not found\nPermission denied");
    expect(hit?.name).toBe("command_missing");
    expect(hit?.line).toBe("bash: x: command not found");
  });

  it("only reads a usage: marker at the start of a line", () => {
    expect(errorClassOf("see usage: here")).toBeUndefined();
  });

  it("is undefined for an output with no environment error", () => {
    expect(errorClassOf("3 passed in 0.1s")).toBeUndefined();
  });
});
