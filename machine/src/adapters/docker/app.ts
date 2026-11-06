// The app the machine starts for the browser run: its own container on its own card network (the `check` list, no engine host, no credential),
// reachable from the browser run as `luna-app`, with no port published on the host. The argument list is the check container's hardening, detached.
import { sandboxExecArgs, type SandboxExec } from "./docker.ts";
import { type ExecResult, exec as hostExec } from "../process/exec.ts";

export const APP_ALIAS = "luna-app";

export interface AppSpec extends Pick<SandboxExec, "image" | "worktree" | "limits" | "cacheVolume" | "cardNetwork" | "services" | "serviceEnv" | "user"> {
  name: string;
  command: string;
  port: number;
  /** Secret values by name: only the names are used here; the values go in the docker client's environment. */
  secrets?: Record<string, string>;
}

/** `docker run -d` for the app. Pure. */
export function appArgs(spec: AppSpec): string[] {
  const { command, port, ...rest } = spec;
  const args = sandboxExecArgs({ ...rest, argv: ["sh", "-c", command], env: { PORT: String(port), HOST: "0.0.0.0" } });
  // `run --rm --name N ...` becomes `run -d --name N --network-alias luna-app ...`: the app outlives the call and has a name to be reached by.
  const name = args.indexOf("--name");
  return ["run", "-d", ...args.slice(2, name + 2), "--network-alias", APP_ALIAS, ...args.slice(name + 2)];
}

/** Asks the app itself, from inside its container, whether `path` answers below 400. The path is an argument, never part of the script. */
export const PROBE_SCRIPT = 'const http=require("node:http");const r=http.get({host:"127.0.0.1",port:Number(process.argv[1]),path:process.argv[2],timeout:2000},(res)=>{res.resume();process.exit(res.statusCode<400?0:1)});r.on("error",()=>process.exit(1));r.on("timeout",()=>process.exit(1));';

export const probeArgs = (container: string, port: number, path: string): string[] => ["exec", container, "/opt/luna/bin/node", "-e", PROBE_SCRIPT, String(port), path];

/** Removes app containers (and the proxies and services named after them) a killed machine left running. */
export async function removeLeftoverApps(exec: (command: string, args: string[]) => Promise<ExecResult> = hostExec): Promise<number> {
  const listed = await exec("docker", ["ps", "-q", "--filter", "label=dev.hardness.stage=1", "--filter", "name=-app-"]);
  const ids = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length > 0) await exec("docker", ["rm", "-f", ...ids]);
  return ids.length;
}
