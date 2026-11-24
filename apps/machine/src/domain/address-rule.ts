// The address rule: a text a model wrote, or a stranger's words passed through one, may hold one address at most, the card's own PR link, given by
// the machine. Slack links a bare `name.tld` by itself, so a domain-shaped token counts as an address; so does any scheme. A file name (`README.md`)
// is allowed only when the very token is in a docs excerpt the machine supplied and its ending is a file extension, not a top-level domain in use.
// Pure.

const SCHEME = /(?:^|[^a-z0-9+.-])(?:[a-z][a-z0-9+.-]{1,30}:\/\/|(?:mailto|tel|sms|javascript|data|file|vbscript|ftp):)/i;
const DOMAIN = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![a-z0-9-])/gi;
const FILE_ENDINGS = new Set(["md", "ts", "tsx", "js", "jsx", "mjs", "json", "yaml", "yml", "toml", "txt", "rs", "go", "py", "rb", "sql", "css", "lock", "env", "cfg", "ini"]);
const INVISIBLE = /[​-‍⁠﻿]/g;
const TRAILING = /[.,;:!?]+$/;

/** The domain-shaped tokens of some text (the files a docs excerpt names, once their endings are checked by the caller). */
export function domainTokens(text: string): string[] {
  return (text.replace(INVISIBLE, "").match(DOMAIN) ?? []).filter(isDomainLike);
}

/** A label that is all lowercase or all capitals ends a domain; `done.Thanks` (a missing space) does not. */
function isDomainLike(token: string): boolean {
  const last = token.slice(token.lastIndexOf(".") + 1);
  return last === last.toLowerCase() || last === last.toUpperCase();
}

/** Whether `text` holds an address other than the exact ones in `given`; `files` are the tokens of the machine's own context that may stand as file names. */
export function holdsForeignAddress(text: string, context: { given: Iterable<string>; files?: Iterable<string> }): boolean {
  const given = new Set(context.given);
  const files = new Set(context.files ?? []);
  for (const piece of text.replace(INVISIBLE, "").split(/[\s<>"'()[\]|]+/)) {
    const token = piece.replace(TRAILING, "");
    if (token === "" || given.has(token)) continue;
    if (SCHEME.test(token) || /^www\./i.test(token)) return true;
    for (const found of token.match(DOMAIN) ?? []) {
      if (!isDomainLike(found)) continue;
      const ending = found.slice(found.lastIndexOf(".") + 1);
      if (files.has(found) && FILE_ENDINGS.has(ending)) continue;
      return true;
    }
  }
  return false;
}
