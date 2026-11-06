// The source test (the pattern of `contracts/src/engines.test.ts`): every call that writes to Slack lives behind `SlackSender`, and every authority
// is made in exactly the places that may make one. Tests are not scanned.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });

/**
 * The code of a source file with the inside of every string, template, regular expression and comment emptied (the quotes stay, a `${...}` in a
 * template stays as code, newlines stay), so a guard reads calls and casts and is fooled by neither a backtick on the line nor a name in a comment.
 */
export function code(src: string): string {
  let i = 0;
  const run = (until: string | null): string => {
    let out = "";
    let depth = 0;
    let last = "";
    while (i < src.length) {
      const c = src[i]!;
      const two = src.slice(i, i + 2);
      if (until !== null && c === "}" && depth === 0) return out;
      if (two === "//") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (two === "/*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? src.length : end + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, "");
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        out += c;
        i++;
        while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        out += c;
        i++;
        last = c;
        continue;
      }
      if (c === "`") {
        out += c;
        i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") i += 2;
          else if (src.slice(i, i + 2) === "${") {
            i += 2;
            out += "${" + run("}") + "}";
            i++;
          } else {
            if (src[i] === "\n") out += "\n";
            i++;
          }
        }
        out += c;
        i++;
        last = c;
        continue;
      }
      if (c === "/" && (last === "" || "(,=:[!&|?{};".includes(last))) {
        out += c;
        i++;
        let inClass = false;
        while (i < src.length && src[i] !== "\n" && (src[i] !== "/" || inClass)) {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          i++;
        }
        out += "/";
        i++;
        last = "/";
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") depth--;
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
    return out;
  };
  return run(null);
}

const sources = files(SRC).map((path) => ({ path: relative(SRC, path), text: code(readFileSync(path, "utf8")) }));
const where = (pattern: RegExp): string[] => sources.filter((s) => pattern.test(s.text)).map((s) => s.path).sort();

const WRITE_CALLS = [/\bpostMessage\(/, /\bopenDm\(/, /\bchat\.postMessage/, /\bchat\.update/, /\bchat\.delete/, /\breactions\.add/, /\bconversations\.mark/, /\bconversations\.open/];
/** The lines of (already stripped) code that call a write on anything but a `sender` handed an authority, and are not a method's own declaration. */
export const bareWrites = (text: string): string[] =>
  text.split("\n").filter((l) => WRITE_CALLS.some((p) => p.test(l)) && !/\bsender\.\w+\((?:tap|auth|standing)\b/.test(l) && !/^\s*async \w+\(/.test(l));
/** The lines that make an authority by a cast instead of by its door. */
export const authorityCasts = (text: string): string[] => text.split("\n").filter((l) => /\bas\s+(?:Tap|Standing|Authority)\b/.test(l));

const DOOR = ["adapters/slack/web-api.ts", "application/slack.ts", "application/slack-send.ts"];

describe("what may write to Slack", () => {
  it("names the port's write calls and the raw API methods only in the adapter, the port and the sender", () => {
    for (const pattern of WRITE_CALLS) {
      const found = where(pattern).filter((p) => !DOOR.includes(p));
      // A call on a `sender` takes an authority as its first argument; anything else is a call on the port itself.
      const bare = found.filter((p) => bareWrites(sources.find((s) => s.path === p)!.text).length > 0);
      expect(bare, String(pattern)).toEqual([]);
    }
    const mark = where(/\b(?:slack|port|slackApi|options\.slack)\.mark\(/);
    expect(mark.filter((p) => !DOOR.includes(p))).toEqual([]);
  });
  it("makes a Tap only in the HTTP adapter, an event's tap only in threads.ts, and a standing only in threads.ts and slack-inbox.ts", () => {
    const outside = (pattern: RegExp, allowed: string[]) => where(pattern).filter((p) => p !== "application/slack-send.ts" && !allowed.includes(p));
    expect(outside(/\btapOf\(/, ["adapters/http/app.ts"])).toEqual([]);
    expect(outside(/\btapOfEvent\(/, ["application/threads.ts"])).toEqual([]);
    expect(outside(/\bstandingOf\(/, ["application/threads.ts", "application/slack-inbox.ts"])).toEqual([]);
  });
  it("makes no Tap, Standing or Authority by a cast outside the sender", () => {
    expect(sources.filter((s) => s.path !== "application/slack-send.ts" && authorityCasts(s.text).length > 0).map((s) => s.path)).toEqual([]);
  });
  it("bites: a scratch copy with a write on a template literal and a cast is flagged by both matchers, and a comment or a string is not", () => {
    const scratch = code(["const room = 1;", "await port.postMessage(`C1`, `hello ${name}`);", "const t = {} as Tap;", "// port.postMessage(x) as Standing", 'const s = "sender.postMessage( as Authority";', "const r = /['\"`]/g;"].join("\n"));
    expect(bareWrites(scratch)).toEqual(["await port.postMessage(``, `${name}`);"]);
    expect(authorityCasts(scratch)).toEqual(["const t = {} as Tap;"]);
    expect(code("const a = `x ${sender.postMessage(tap, c, `y`)} z`;")).toBe("const a = `${sender.postMessage(tap, c, ``)}`;");
  });
  it("hands the inbox and the replies no write-capable port type of their own: both build or receive a SlackSender", () => {
    expect(where(/new SlackSender\(/).sort()).toEqual(["application/slack-inbox.ts", "application/threads.ts", "main.ts"]);
  });
});
