// Replaces a secret's value, wherever the machine is about to keep or post text a step produced, with `[secret:NAME]`. The value and its
// base64, base64url, percent-encoded and JSON-escaped forms; the longest first, so a value that holds a shorter one goes whole. Pure.
// Not covered, and said so in docs: a value reversed, split, hex or gzipped, and pixels.

/** The text forms one value takes in output. */
function formsOf(value: string): string[] {
  const forms = [
    value,
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    Buffer.from(value).toString("base64").replace(/=+$/, ""),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ];
  return [...new Set(forms)].filter((form) => form.length >= 4);
}

/** A function that replaces each secret in its argument; with no secret it returns its input. */
export function secretRedactor(secrets: Readonly<Record<string, string>>): (text: string) => string {
  const pairs = Object.entries(secrets)
    .filter(([, value]) => value.length > 0)
    .flatMap(([name, value]) => formsOf(value).map((form) => ({ form, name })))
    .sort((a, b) => b.form.length - a.form.length);
  if (pairs.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const { form, name } of pairs) if (out.includes(form)) out = out.split(form).join(`[secret:${name}]`);
    return out;
  };
}

/** `value` with every string (object keys included) passed through `redact`; other values are kept as they are. */
export function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)]));
  return value;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The redactor for a host name: the same forms, matched without regard to case, because the proxy lowercases the hosts it logs. */
export function hostRedactor(secrets: Readonly<Record<string, string>>): (text: string) => string {
  const pairs = Object.entries(secrets)
    .filter(([, value]) => value.length > 0)
    .flatMap(([name, value]) => formsOf(value).map((form) => ({ form, name })))
    .sort((a, b) => b.form.length - a.form.length);
  if (pairs.length === 0) return (text) => text;
  return (text) => pairs.reduce((out, { form, name }) => out.replace(new RegExp(escapeRegExp(form), "gi"), `[secret:${name}]`), text);
}
