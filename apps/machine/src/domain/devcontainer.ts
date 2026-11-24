// What a repository's `.devcontainer/devcontainer.json` gives the machine: an image, a Dockerfile to build, and non-secret container env.
// The file is JSONC and repo-controlled text. Every other key is listed as "not applied" with the reason, never silently ignored.

/** JSON with `//` and block comments and trailing commas removed; text inside strings is kept as it is. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === ",") {
      // A comma is trailing when only whitespace and comments lie between it and the closing bracket.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j += 1;
        if (text[j] === "/" && text[j + 1] === "/") while (j < text.length && text[j] !== "\n") j += 1;
        else if (text[j] === "/" && text[j + 1] === "*") j = text.indexOf("*/", j + 2) === -1 ? text.length : text.indexOf("*/", j + 2) + 2;
        else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export interface DevcontainerDockerfile {
  dockerfile: string;
  context: string | null;
  args: Record<string, string>;
}

export type Devcontainer = { ok: true; image: string | null; dockerfile: DevcontainerDockerfile | null; containerEnv: Record<string, string>; notApplied: string[] } | { ok: false; reason: string };

const NOT_APPLIED: Record<string, string> = {
  features: "they need the devcontainers CLI, which the machine does not run",
  postCreateCommand: "the machine runs the repo's install and checks from luna.yaml",
  postStartCommand: "the machine runs the repo's install and checks from luna.yaml",
  postAttachCommand: "the machine runs the repo's install and checks from luna.yaml",
  onCreateCommand: "the machine runs the repo's install and checks from luna.yaml",
  updateContentCommand: "the machine runs the repo's install and checks from luna.yaml",
  initializeCommand: "a repo does not get to run commands on the host",
  mounts: "a repo cannot add mounts to its sandbox",
  runArgs: "a repo cannot add docker flags to its sandbox",
  remoteUser: "stages run as the machine's own user",
  containerUser: "stages run as the machine's own user",
  dockerComposeFile: "compose setups are not supported; name services in luna.yaml",
};

/** Names a repo's container env may not set: the proxy, the loader, the path, and what the machine sets itself. */
const RESERVED_ENV = /^(?:(?:HTTPS?|NO|YARN_HTTPS?|ALL|FTP)_PROXY|NODE_USE_ENV_PROXY|PATH|HOME|TMPDIR|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_.*|GIT_.*|HARDNESS_.*|LUNA_.*|CODEX_HOME|COREPACK_.*|CLAUDE_.*|ANTHROPIC_.*)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV = 50;
const MAX_VALUE = 1024;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function devcontainerOf(text: string): Devcontainer {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (error) {
    return { ok: false, reason: `devcontainer.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(raw)) return { ok: false, reason: "devcontainer.json is not an object" };
  const notApplied: string[] = [];
  for (const [key, why] of Object.entries(NOT_APPLIED)) if (key in raw) notApplied.push(`devcontainer.json ${key}: not applied: ${why}`);

  const image = typeof raw.image === "string" && raw.image.length > 0 ? raw.image : null;
  let dockerfile: DevcontainerDockerfile | null = null;
  if (isRecord(raw.build) && typeof raw.build.dockerfile === "string" && raw.build.dockerfile.length > 0) {
    const args: Record<string, string> = {};
    if (isRecord(raw.build.args)) for (const [k, v] of Object.entries(raw.build.args)) if (typeof v === "string") args[k] = v;
    dockerfile = { dockerfile: raw.build.dockerfile, context: typeof raw.build.context === "string" ? raw.build.context : null, args };
  }

  const containerEnv: Record<string, string> = {};
  if (isRecord(raw.containerEnv)) {
    for (const [name, value] of Object.entries(raw.containerEnv)) {
      if (Object.keys(containerEnv).length >= MAX_ENV) {
        notApplied.push(`devcontainer.json containerEnv: not applied past ${MAX_ENV} entries`);
        break;
      }
      if (typeof value !== "string" || value.length > MAX_VALUE || /[\0\n\r]/.test(value)) notApplied.push(`devcontainer.json containerEnv ${name.slice(0, 60)}: not applied: only plain string values are taken`);
      else if (!ENV_NAME.test(name)) notApplied.push(`devcontainer.json containerEnv ${name.slice(0, 60)}: not applied: not a variable name`);
      else if (RESERVED_ENV.test(name)) notApplied.push(`devcontainer.json containerEnv ${name}: not applied: the machine owns that variable`);
      else containerEnv[name] = value;
    }
  }
  return { ok: true, image, dockerfile, containerEnv, notApplied };
}
