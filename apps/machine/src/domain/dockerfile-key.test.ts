import { describe, expect, it } from "vitest";

import { dockerfileKey } from "./dockerfile-key.ts";

const base = { text: "FROM debian:12\nRUN true\n", args: { B: "2", A: "1" }, context: ".devcontainer" };

describe("the key a person approves for a repository's Dockerfile", () => {
  it("is `dockerfile=sha256:` and 64 hex characters, which no image reference can be", () => {
    expect(dockerfileKey(base)).toMatch(/^dockerfile=sha256:[0-9a-f]{64}$/);
  });

  it("does not depend on the order the build args were written in", () => {
    expect(dockerfileKey({ ...base, args: { A: "1", B: "2" } })).toBe(dockerfileKey(base));
  });

  it("changes with a byte of the Dockerfile, an arg's name or value, and the context", () => {
    const k = dockerfileKey(base);
    expect(dockerfileKey({ ...base, text: `${base.text}# x\n` })).not.toBe(k);
    expect(dockerfileKey({ ...base, args: { ...base.args, B: "3" } })).not.toBe(k);
    expect(dockerfileKey({ ...base, args: { ...base.args, C: "" } })).not.toBe(k);
    expect(dockerfileKey({ ...base, context: "." })).not.toBe(k);
  });

  it("cannot be forged by moving text between the Dockerfile, the args and the context", () => {
    expect(dockerfileKey({ text: "a", args: {}, context: "b" })).not.toBe(dockerfileKey({ text: "ab", args: {}, context: "" }));
    expect(dockerfileKey({ text: "x", args: { A: "1" }, context: "." })).not.toBe(dockerfileKey({ text: "x", args: { "A=1": "" }, context: "." }));
  });
});
