import { describe, expect, it } from "vitest";

import { registryHostsOf } from "./registry-hosts.ts";

const lock = (name: string, text = "") => ({ name, text });

describe("registryHostsOf", () => {
  it("gives each ecosystem its own hosts for a lockfile that is present, and nothing for none", () => {
    expect(registryHostsOf([])).toEqual([]);
    expect(registryHostsOf([lock("package-lock.json")])).toEqual(["registry.npmjs.org"]);
    expect(registryHostsOf([lock("pnpm-lock.yaml")])).toEqual(["registry.npmjs.org"]);
    expect(registryHostsOf([lock("bun.lock")])).toEqual(["registry.npmjs.org"]);
    expect(registryHostsOf([lock("bun.lockb", "\u0000\u0001binary https://evil.example/x.tgz resolved")])).toEqual(["registry.npmjs.org"]);
    expect(registryHostsOf([lock("yarn.lock")])).toEqual(["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"]);
    expect(registryHostsOf([lock("Cargo.lock")])).toEqual(["crates.io", "index.crates.io", "static.crates.io"]);
    expect(registryHostsOf([lock("go.sum")])).toEqual(["proxy.golang.org", "sum.golang.org"]);
    for (const name of ["poetry.lock", "uv.lock", "Pipfile.lock"]) expect(registryHostsOf([lock(name)])).toEqual(["files.pythonhosted.org", "pypi.org"]);
    expect(registryHostsOf([lock("Gemfile.lock")])).toEqual(["index.rubygems.org", "rubygems.org"]);
    expect(registryHostsOf([lock("composer.lock")])).toEqual(["packagist.org", "repo.packagist.org"]);
  });

  it("ignores a file that is not a lockfile name", () => {
    expect(registryHostsOf([lock("package.json", '"resolved": "https://x.example.com/a.tgz"'), lock("../package-lock.json")])).toEqual([]);
  });

  it("adds the hosts of the https URLs a lockfile names after resolved, url, tarball, remote and source", () => {
    const text = [
      '"resolved": "https://npm.pkg.example.com/left-pad/-/left-pad-1.0.0.tgz",',
      "  resolution: {tarball: https://artifacts.example.org/a.tgz}",
      '  resolved "https://Registry.Yarnpkg.com/x/-/x-1.tgz#abc"',
      'url = "https://files.example.net/p.whl"',
      "  remote: https://rubygems.example.io/",
      'source = "registry+https://index.crates.example.dev/"',
      'name = "ignored https://not-on-a-keyed-line.example.com"',
    ].join("\n");
    expect(registryHostsOf([lock("package-lock.json", text)])).toEqual([
      "artifacts.example.org", "files.example.net", "index.crates.example.dev", "npm.pkg.example.com", "registry.npmjs.org", "registry.yarnpkg.com", "rubygems.example.io",
    ]);
  });

  it("drops a URL with userinfo, an IP, localhost, a local name, an odd port or a plain http scheme, and keeps :443 as the bare host", () => {
    const text = [
      '"resolved": "https://user:pw@private.example.com/x.tgz"',
      '"resolved": "https://10.0.0.5/x.tgz"',
      '"resolved": "https://[::1]/x.tgz"',
      '"resolved": "https://localhost/x.tgz"',
      '"resolved": "https://nexus.internal/x.tgz"',
      '"resolved": "https://odd.example.com:8443/x.tgz"',
      '"resolved": "http://plain.example.com/x.tgz"',
      '"resolved": "https://ok.example.com:443/x.tgz"',
      '"resolved": "git+ssh://git@github.com/o/r.git"',
      '"resolved": "file:../local"',
    ].join("\n");
    expect(registryHostsOf([lock("package-lock.json", text)])).toEqual(["ok.example.com", "registry.npmjs.org"]);
  });

  it("caps the list at twenty, keeping every ecosystem host, and sorts it", () => {
    const urls = Array.from({ length: 40 }, (_, i) => `"resolved": "https://h${String(i).padStart(2, "0")}.example.com/a.tgz"`).join("\n");
    const hosts = registryHostsOf([lock("yarn.lock", urls)]);
    expect(hosts).toHaveLength(20);
    expect(hosts).toEqual([...hosts].sort());
    for (const own of ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"]) expect(hosts).toContain(own);
  });
});

describe("registryHostsOf: lockfiles in subfolders", () => {
  it("takes each nested lockfile's ecosystem hosts by its name, and never a host from its text", () => {
    expect(registryHostsOf([], ["board/Cargo.lock", "svc/poetry.lock", "docs/notes.md"])).toEqual(["crates.io", "files.pythonhosted.org", "index.crates.io", "pypi.org", "static.crates.io"]);
    expect(registryHostsOf([{ name: "pnpm-lock.yaml", text: "" }], ["board/Cargo.lock"])).toContain("registry.npmjs.org");
  });
});
