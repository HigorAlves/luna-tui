// What a `luna.yaml` may say about hosts, secrets and URLs. Pure checks, shared by the config schema and by the
// machine's own lists. `luna.yaml` is repository input: nothing here trusts a spelling.

/** A name or number in an address position: dotted, decimal, hex or octal IPv4 (WHATWG parses all of them as an address). */
const NUMERIC_LABEL = /^(0x[0-9a-f]*|\d+)$/i;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = [".internal", ".local", ".localhost"];

/** True for text that is an IPv4 address in any spelling, or any IPv6 literal. Names never end in a number. */
export function isIpLiteral(host: string): boolean {
  const text = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (text.includes(":")) return true;
  const labels = text.replace(/\.$/, "").split(".");
  return NUMERIC_LABEL.test(labels[labels.length - 1] ?? "");
}

/** The pattern as the proxy compares it: trimmed and lowercased. */
export function normalizeHostPattern(text: string): string {
  return text.trim().toLowerCase();
}

/** Why `text` is not an allowed-host pattern (`host`, `host:port` or `*.suffix`, with an optional port), or null. */
export function hostPatternProblem(text: string): string | null {
  const name = JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
  const refuse = (why: string): string => `${name}: ${why}`;
  if (text.length === 0) return refuse("is empty");
  if (text.length > 253) return refuse("is longer than 253 characters");
  if (/[\u0000- \u007f]/.test(text)) return refuse("has a space or control character");
  if (/[^!-~]/.test(text)) return refuse("has a character outside a host name (write the punycode form)");
  if (text.includes("://")) return refuse("has a scheme; write only the host");
  if (text.includes("/") || text.includes("?") || text.includes("#")) return refuse("has a path; write only the host");
  if (text.includes("@")) return refuse("has userinfo; write only the host");
  const value = text.toLowerCase();
  if (value.startsWith("[") || (value.match(/:/g) ?? []).length > 1) return refuse("is an IPv6 address; hosts are listed by name");
  let host = value;
  const colon = value.indexOf(":");
  if (colon >= 0) {
    host = value.slice(0, colon);
    const port = value.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return refuse("has a port outside 1 to 65535");
  }
  if (host === "*") return refuse("is a wildcard for every host");
  const wildcard = host.startsWith("*.");
  const body = wildcard ? host.slice(2) : host;
  if (body.includes("*")) return refuse("has a wildcard that is not the whole first label");
  if (isIpLiteral(body)) return refuse("is an IP address; hosts are listed by name");
  const labels = body.split(".");
  if (labels.length < 2) return refuse("is a name with no dot");
  if (body === "localhost" || LOCAL_SUFFIXES.some((s) => body.endsWith(s))) return refuse("is a local name");
  for (const label of labels) if (!LABEL.test(label)) return refuse("has an empty or malformed label");
  return null;
}

/** Names a secret may never take: the engines' and the machine's own variables. */
const RESERVED_NAMES = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "LMNR_PROJECT_API_KEY",
  "PATH", "HOME", "TMPDIR", "SHELL", "USER", "PWD", "PORT", "HOST",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "YARN_HTTP_PROXY", "YARN_HTTPS_PROXY",
]);
const RESERVED_PREFIXES = ["HARDNESS_", "LUNA_", "MACHINE_", "GIT_", "NODE_", "LD_", "CLAUDE_", "CODEX_", "DOCKER_", "BUILDKIT_"];

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Why `name` cannot name a secret, or null. */
export function secretNameProblem(name: string): string | null {
  const shown = JSON.stringify(name.length > 80 ? `${name.slice(0, 77)}...` : name);
  if (!SECRET_NAME.test(name)) return `${shown}: a secret's name is upper case letters, digits and underscores, 2 to 64 characters, starting with a letter`;
  if (RESERVED_NAMES.has(name)) return `${shown}: is a variable the machine or an engine uses`;
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `${shown}: names starting ${prefix} belong to the machine and the engines`;
  return null;
}

/** The placeholders the machine fills in a preview URL. */
export const PREVIEW_PLACEHOLDERS = ["branch", "sha", "short_sha", "card"] as const;

/** Why `pattern` is not a preview URL pattern (https, no userinfo, query or fragment, only the machine's placeholders, none in the last two labels of the host), or null. */
export function urlPatternProblem(pattern: string): string | null {
  const shown = JSON.stringify(pattern.length > 120 ? `${pattern.slice(0, 117)}...` : pattern);
  if (!pattern.startsWith("https://")) return `${shown}: must start with https://`;
  if (/[^!-~]/.test(pattern)) return `${shown}: has a space, control or non-ASCII character`;
  const stripped = pattern.replace(/\{(branch|sha|short_sha|card)\}/g, "x");
  if (/[{}]/.test(stripped)) return `${shown}: the only placeholders are ${PREVIEW_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`;
  if (stripped.includes("?") || stripped.includes("#")) return `${shown}: has a query or a fragment`;
  const authorityEnd = stripped.indexOf("/", "https://".length);
  const authority = stripped.slice("https://".length, authorityEnd < 0 ? undefined : authorityEnd);
  if (authority.includes("@")) return `${shown}: has userinfo`;
  const hostProblem = hostPatternProblem(authority);
  if (hostProblem) return `${shown}: host ${hostProblem}`;
  const rawAuthority = pattern.slice("https://".length, pattern.indexOf("/", "https://".length) < 0 ? undefined : pattern.indexOf("/", "https://".length));
  const rawHost = rawAuthority.split(":")[0]!;
  const tail = rawHost.split(".").slice(-2).join(".");
  if (tail.includes("{")) return `${shown}: a placeholder may not be in the last two labels of the host`;
  return null;
}
