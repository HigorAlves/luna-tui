import { describe, expect, it } from "vitest";

import { holdsForeignAddress } from "./address-rule.ts";

const PR = "https://github.com/acme/app/pull/4";
const held = (text: string, files: string[] = []) => holdsForeignAddress(text, { given: [PR], files });

describe("holdsForeignAddress: a text holds no address but the one it was given", () => {
  it("refuses a bare domain with a path, a bare domain alone, any scheme and a www address", () => {
    expect(held("see login-acme.example.com/verify for details")).toBe(true);
    expect(held("it is on evil.io now")).toBe(true);
    expect(held("go to https://evil.example/x")).toBe(true);
    expect(held("go to http://github.com/acme/app/pull/5")).toBe(true);
    expect(held("www.evil.example")).toBe(true);
    expect(held("mail me: a@evil.example")).toBe(true);
    expect(held("click javascript:alert(1)")).toBe(true);
    expect(held("EVIL.COM is shouting")).toBe(true);
  });
  it("refuses an address that only starts like the given one", () => {
    expect(held(`${PR}.evil.example`)).toBe(true);
    expect(held("https://github.com.evil.example/acme/app/pull/4")).toBe(true);
  });
  it("allows the given PR link, repeated, with a trailing full stop or in brackets", () => {
    expect(held(`PR: ${PR}`)).toBe(false);
    expect(held(`PR: ${PR}. Again ${PR}`)).toBe(false);
    expect(held(`(${PR})`)).toBe(false);
  });
  it("allows a file name only when it is in the files the machine supplied, and a version number or plain prose always", () => {
    expect(held("see README.md and app.ts")).toBe(true);
    expect(held("see README.md and app.ts", ["README.md", "app.ts"])).toBe(false);
    expect(held("see README.md and evil.com", ["README.md", "evil.com"])).toBe(true);
    expect(held("it shipped in 1.2.3 and v2.0, e.g. today. Done.Thanks")).toBe(false);
  });
});
