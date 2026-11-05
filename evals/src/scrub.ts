// Scrubbing a decision record before it becomes a committed case or a Laminar datapoint. A record
// is the machine's own data (its contexts come from repos it reads), so everything that could name
// a person, a host or a machine is replaced, and anything token-shaped REFUSES the record: a secret
// is never redacted and kept. Pure; the unit test over `evals/**` stays the final gate.

/** The shapes the cases test refuses too: Slack, GitHub, OpenAI-style, AWS and JWT tokens. */
export const TOKEN_SHAPE = /xox[abposr]-|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Keys whose string value names a person. */
const LOGIN_KEYS = new Set(["author", "actor", "login", "user", "assignee", "approver", "reviewer", "requestedBy", "owner", "name"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/g;
const PATH = /(?:\/Users|\/home|\/private|\/var\/folders|\/opt|\/mnt|\/root)\/[^\s"'<>):,;]+/g;
/** Hosts a public document may link to unchanged. */
const PUBLIC_HOSTS = /^(?:[a-z0-9-]+\.)*(?:github\.com|gitlab\.com|npmjs\.com|mozilla\.org|wikipedia\.org|stackoverflow\.com|nodejs\.org|typescriptlang\.org|rust-lang\.org|python\.org|example\.(?:com|org|net)|[a-z0-9-]+\.example)$/i;

export type Scrubbed = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Every string value in `value`, with its path. */
function strings(value: unknown, path: string[] = [], out: Array<{ path: string[]; key: string; text: string }> = []): Array<{ path: string[]; key: string; text: string }> {
  if (typeof value === "string") out.push({ path, key: path.at(-1) ?? "", text: value });
  else if (Array.isArray(value)) value.forEach((item, i) => strings(item, [...path, String(i)], out));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) strings(item, [...path, key], out);
  return out;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scrubContext(context: Record<string, unknown>): Scrubbed {
  const all = strings(context);
  const token = all.find((s) => TOKEN_SHAPE.test(s.text));
  if (token) return { ok: false, reason: `a token-shaped string at ${token.path.join(".")}` };

  // Logins first, in the order they appear, so user-N is stable for one record.
  const logins = new Map<string, string>();
  for (const { key, text } of all) {
    const name = text.trim();
    if (LOGIN_KEYS.has(key) && name.length >= 2 && !/\s/.test(name) && !logins.has(name.toLowerCase())) logins.set(name.toLowerCase(), `user-${logins.size + 1}.example`);
  }
  const loginRe = logins.size > 0 ? new RegExp(`(?<![A-Za-z0-9_.-])(${[...logins.keys()].map(escapeRe).join("|")})(?![A-Za-z0-9_-])`, "gi") : null;
  const emails = new Map<string, string>();
  const hosts = new Map<string, string>();
  const hostOf = (host: string) => {
    if (!hosts.has(host)) hosts.set(host, `host-${hosts.size + 1}.example`);
    return hosts.get(host)!;
  };

  const clean = (text: string): string => {
    let out = text.replace(PATH, (match) => `/work/${match.split("/").filter(Boolean).slice(-2).join("/")}`);
    out = out.replace(EMAIL, (match) => {
      if (/@(?:[a-z0-9-]+\.)*example(?:\.|$)/i.test(match)) return match;
      if (!emails.has(match)) emails.set(match, `user-${emails.size + 1}@mail.example`);
      return emails.get(match)!;
    });
    out = out.replace(URL_RE, (match) => {
      const url = (() => {
        try {
          return new URL(match);
        } catch {
          return null;
        }
      })();
      if (!url) return match;
      const rest = `${url.pathname}${url.search}${url.hash}`;
      if (url.hostname === "github.com") return `${url.protocol}//github.com${rest.replace(/^\/[^/]+/, "/example")}`;
      return PUBLIC_HOSTS.test(url.hostname) ? match : `${url.protocol}//${hostOf(url.hostname)}${rest}`;
    });
    return loginRe ? out.replace(loginRe, (match) => logins.get(match.toLowerCase())!) : out;
  };

  const walk = (value: unknown): unknown => (typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(walk) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value);
  const value = walk(context) as Record<string, unknown>;
  // The scrub must not have made a token: re-check what it produced.
  const after = strings(value).find((s) => TOKEN_SHAPE.test(s.text));
  return after ? { ok: false, reason: `a token-shaped string at ${after.path.join(".")}` } : { ok: true, value };
}
