import { describe, expect, it } from "vitest";

import { devcontainerOf, stripJsonc } from "./devcontainer.ts";

describe("JSONC", () => {
  it("drops line and block comments and trailing commas, and keeps what is inside strings", () => {
    const text = `{
      // the image
      "image": "node:22", /* inline */
      "url": "https://example.com/a//b", "glob": "/* not a comment */",
      "list": [1, 2,],
      "last": "x\\"//still a string",
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ image: "node:22", url: "https://example.com/a//b", glob: "/* not a comment */", list: [1, 2], last: 'x"//still a string' });
  });

  it("leaves an unterminated block comment out and a plain JSON file as it is", () => {
    expect(JSON.parse(stripJsonc('{"a":1} /* open'))).toEqual({ a: 1 });
    expect(stripJsonc('{"a":[1,2]}')).toBe('{"a":[1,2]}');
  });
});

describe("what a devcontainer.json gives the machine", () => {
  it("reads the image and the container env", () => {
    const got = devcontainerOf('{ "image": "node:22-bookworm", "containerEnv": { "CI": "1", "N": "x y" } }');
    expect(got).toEqual({ ok: true, image: "node:22-bookworm", dockerfile: null, containerEnv: { CI: "1", N: "x y" }, notApplied: [] });
  });

  it("lists each key it does not apply with the reason", () => {
    const got = devcontainerOf(JSON.stringify({ image: "a:1", features: {}, postCreateCommand: "x", mounts: [], runArgs: [], remoteUser: "vscode" }));
    expect(got).toMatchObject({ ok: true });
    const notes = (got as { notApplied: string[] }).notApplied;
    for (const key of ["features", "postCreateCommand", "mounts", "runArgs", "remoteUser"]) expect(notes.some((n) => n.startsWith(`devcontainer.json ${key}: not applied: `)), key).toBe(true);
  });

  it("reads build.dockerfile with its context and args, and does not take it as an image", () => {
    const got = devcontainerOf('{ "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "1" } } }');
    expect(got).toMatchObject({ ok: true, image: null, dockerfile: { dockerfile: "Dockerfile", context: "..", args: { V: "1" } } });
  });

  it("drops a container env entry that is not a plain string, or would take over the proxy or the loader", () => {
    const got = devcontainerOf(JSON.stringify({ containerEnv: { OK: "1", HTTPS_PROXY: "http://evil", LD_PRELOAD: "/x", PATH: "/x", "bad name": "1", NUM: 3, HARDNESS_X: "1" } }));
    expect(got).toMatchObject({ ok: true, containerEnv: { OK: "1" } });
    expect((got as { notApplied: string[] }).notApplied.join("\n")).toContain("containerEnv HTTPS_PROXY: not applied");
  });

  it("says why a file that is not JSON gives nothing", () => {
    expect(devcontainerOf("{ nope")).toMatchObject({ ok: false, reason: expect.stringContaining("devcontainer.json") });
    expect(devcontainerOf("[1]")).toMatchObject({ ok: false });
  });
});
