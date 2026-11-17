import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BOOT = fileURLToPath(new URL("../../brain/boot.sh", import.meta.url));

/** A folder with a fake `omnigraph` and a fake server on it: each writes what it was asked to `log`. The fake apply leaves a lock, as the real one does. */
function stage(options: { applyFails?: true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brain-boot-"));
  const bin = join(root, "bin");
  const cluster = join(root, "cluster");
  const log = join(root, "log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "omnigraph"),
    `#!/bin/sh
echo "$1 $2 $3" >> "${log}"
case "$2" in
  apply) ${options.applyFails ? "exit 1" : `mkdir -p "${cluster}/__cluster" && printf '{\\n  "version": 1,\\n  "lock_id": "LOCK-APPLY",\\n  "operation": "apply"\\n}\\n' > "${cluster}/__cluster/lock.json"`} ;;
  force-unlock) rm -f "${cluster}/__cluster/lock.json" ;;
esac
`,
  );
  writeFileSync(join(bin, "server"), `#!/bin/sh\necho "server" >> "${log}"\n`);
  chmodSync(join(bin, "omnigraph"), 0o755);
  chmodSync(join(bin, "server"), 0o755);
  const run = (): number => {
    try {
      execFileSync("/bin/sh", [BOOT], { env: { PATH: `${bin}:/usr/bin:/bin`, OMNIGRAPH_CLUSTER: cluster, BRAIN_CONFIG: root, BRAIN_SERVER: join(bin, "server") }, stdio: "pipe" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  const lock = (text: string): void => {
    mkdirSync(join(cluster, "__cluster"), { recursive: true });
    writeFileSync(join(cluster, "__cluster", "lock.json"), text);
  };
  return { run, lock, said: (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

// RFC 0010, the spike: `cluster apply` keeps its lock, and a killed server keeps its own. The next start is refused until that lock is cleared.
describe("brain/boot.sh", () => {
  it("applies the cluster, clears the lock the apply left, then starts the server", () => {
    const boot = stage();
    expect(boot.run()).toBe(0);
    expect(boot.said()).toEqual(["cluster apply --target", "cluster force-unlock LOCK-APPLY", "server"]);
  });

  it("first clears the lock a killed server left", () => {
    const boot = stage();
    boot.lock('{\n  "version": 1,\n  "lock_id": "LOCK-CRASH",\n  "operation": "serve",\n  "pid": 1\n}\n');
    expect(boot.run()).toBe(0);
    expect(boot.said()).toEqual(["cluster force-unlock LOCK-CRASH", "cluster apply --target", "cluster force-unlock LOCK-APPLY", "server"]);
  });

  it("does not start when the lock file names no lock", () => {
    const boot = stage();
    boot.lock("{}\n");
    expect(boot.run()).not.toBe(0);
    expect(boot.said()).toEqual([]);
  });

  it("does not start the server when the apply fails", () => {
    const boot = stage({ applyFails: true });
    expect(boot.run()).not.toBe(0);
    expect(boot.said()).toEqual(["cluster apply --target"]);
  });
});
