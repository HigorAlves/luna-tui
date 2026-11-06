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
const sources = files(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const where = (pattern: RegExp): string[] => sources.filter((s) => pattern.test(s.text)).map((s) => s.path).sort();

const DOOR = ["adapters/slack/web-api.ts", "application/slack.ts", "application/slack-send.ts"];

describe("what may write to Slack", () => {
  it("names the port's write calls and the raw API methods only in the adapter, the port and the sender", () => {
    for (const pattern of [/\bpostMessage\(/, /\bopenDm\(/, /\bchat\.postMessage/, /\bchat\.update/, /\bchat\.delete/, /\breactions\.add/, /\bconversations\.mark/, /\bconversations\.open/]) {
      const found = where(pattern).filter((p) => !DOOR.includes(p));
      // A call on a `sender` takes an authority as its first argument; anything else is a call on the port itself.
      const bare = found.filter((p) => sources.find((s) => s.path === p)!.text.split("\n").some((l) => pattern.test(l) && !/\bsender\.\w+\((?:tap|auth|standing)\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/`[^`]*`/.test(l) && !/^\s*async \w+\(/.test(l)));
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
  it("hands the inbox and the replies no write-capable port type of their own: both build or receive a SlackSender", () => {
    expect(where(/new SlackSender\(/).sort()).toEqual(["application/slack-inbox.ts", "application/threads.ts", "main.ts"]);
  });
});
