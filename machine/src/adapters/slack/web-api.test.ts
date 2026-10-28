import { describe, expect, it } from "vitest";

import { createSlack } from "./web-api.ts";

interface Call {
  method: string;
  params: Record<string, string>;
  auth: string | null;
  contentType: string | null;
}

/** A fake slack.com: answers per method (an array is consumed call by call), and a log. */
function fakeSlack(answers: Record<string, unknown | unknown[]>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = String(url).replace("https://slack.com/api/", "");
    const headers = init?.headers as Record<string, string>;
    const contentType = headers["Content-Type"] ?? null;
    const body = String(init?.body ?? "");
    const params = contentType?.startsWith("application/json") ? (JSON.parse(body) as Record<string, string>) : Object.fromEntries(new URLSearchParams(body));
    calls.push({ method, params, auth: headers.Authorization ?? null, contentType });
    let answer = answers[method];
    if (Array.isArray(answer)) answer = answer.shift();
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response(JSON.stringify({ ok: false, error: "unknown_method" }), { status: 200 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("createSlack", () => {
  it("sends the Bearer token as a form POST, and JSON for chat.postMessage", async () => {
    const world = fakeSlack({ "auth.test": { ok: true, user_id: "U1", user: "higor" }, "chat.postMessage": { ok: true, ts: "9.1" } });
    const slack = createSlack("xoxp-1", { fetch: world.fetch });
    expect(await slack.me()).toEqual({ id: "U1", name: "higor" });
    expect(await slack.postMessage("C1", "hi", "1.0")).toBe("9.1");
    expect(world.calls[0]).toMatchObject({ method: "auth.test", auth: "Bearer xoxp-1", contentType: "application/x-www-form-urlencoded" });
    expect(world.calls[1]).toMatchObject({ method: "chat.postMessage", params: { channel: "C1", text: "hi", thread_ts: "1.0" }, contentType: "application/json; charset=utf-8" });
  });

  it("throws Slack's error word on ok:false", async () => {
    const world = fakeSlack({ "conversations.mark": { ok: false, error: "missing_scope" } });
    const slack = createSlack("t", { fetch: world.fetch });
    await expect(slack.mark("C1", "1.0")).rejects.toThrow("conversations.mark: missing_scope");
  });

  it("honours Retry-After once, then calls a second 429 a rate limit", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "Retry-After": "3" } });
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const once = fakeSlack({ "usergroups.list": [limited(), { ok: true, usergroups: [{ id: "S1", handle: "platform", name: "Platform" }] }] });
    expect(await createSlack("t", { fetch: once.fetch, sleep }).usergroups()).toEqual([{ id: "S1", handle: "platform", name: "Platform" }]);
    expect(slept).toEqual([3000]);
    expect(once.calls).toHaveLength(2);
    const twice = fakeSlack({ "usergroups.list": [limited(), limited()] });
    await expect(createSlack("t", { fetch: twice.fetch, sleep }).usergroups()).rejects.toThrow(/rate limit/);
    const word = fakeSlack({ "usergroups.list": { ok: false, error: "ratelimited" } });
    await expect(createSlack("t", { fetch: word.fetch, sleep }).usergroups()).rejects.toThrow(/rate limit/);
  });

  it("searches mentions since a ts, oldest first, and filters the day's older hits", async () => {
    const world = fakeSlack({
      "search.messages": {
        ok: true,
        messages: {
          matches: [
            { ts: "1730000000.000100", text: "old", user: "U2", channel: { id: "C1", name: "eng" }, permalink: "p0" },
            { ts: "1730100000.000100", text: "<@U1> hi", user: "U2", channel: { id: "C1", name: "eng" }, permalink: "p1" },
          ],
        },
        response_metadata: { next_cursor: "abc" },
      },
    });
    const page = await createSlack("t", { fetch: world.fetch }).searchMentions("U1", "1730050000.000000");
    expect(page.hits).toEqual([{ ts: "1730100000.000100", text: "<@U1> hi", user: "U2", channel: { id: "C1", name: "eng" }, permalink: "p1" }]);
    expect(page.nextCursor).toBe("abc");
    expect(world.calls[0]!.params).toMatchObject({ query: "<@U1> after:2024-10-26", sort: "timestamp", sort_dir: "asc", cursor: "*", count: "100" });
  });

  it("walks every page of a listing and tells channels, groups and DMs apart", async () => {
    const world = fakeSlack({
      "users.conversations": [
        { ok: true, channels: [{ id: "C1", name: "eng" }, { id: "G1", name: "secret", is_private: true }], response_metadata: { next_cursor: "n2" } },
        { ok: true, channels: [{ id: "C2", name: "ops" }], response_metadata: { next_cursor: "" } },
      ],
      "conversations.list": { ok: true, channels: [{ id: "D1", user: "U2", is_im: true }, { id: "G2", name: "mpdm-a--b", is_mpim: true }] },
    });
    const slack = createSlack("t", { fetch: world.fetch });
    expect(await slack.conversations(["public_channel", "private_channel"])).toEqual([
      { id: "C1", name: "eng", kind: "channel" },
      { id: "G1", name: "secret", kind: "group" },
      { id: "C2", name: "ops", kind: "channel" },
    ]);
    expect(world.calls[1]!.params.cursor).toBe("n2");
    expect(await slack.conversations(["im", "mpim"])).toEqual([
      { id: "D1", name: "U2", kind: "dm" },
      { id: "G2", name: "mpdm-a--b", kind: "mpim" },
    ]);
    expect(world.calls[2]).toMatchObject({ method: "conversations.list", params: { types: "im,mpim" } });
  });

  it("returns history oldest first and replies without the parent", async () => {
    const world = fakeSlack({
      "conversations.history": { ok: true, messages: [{ ts: "3.0", user: "U2", text: "c" }, { ts: "2.0", bot_id: "B1", text: "b", subtype: "bot_message", reply_count: 2, latest_reply: "5.0" }] },
      "conversations.replies": { ok: true, messages: [{ ts: "1.0", user: "U2", text: "parent", thread_ts: "1.0" }, { ts: "4.0", user: "U1", text: "r2", thread_ts: "1.0" }, { ts: "3.5", user: "U3", text: "r1", thread_ts: "1.0" }] },
    });
    const slack = createSlack("t", { fetch: world.fetch });
    expect(await slack.history("C1", "1.0", 50)).toEqual([
      { ts: "2.0", user: null, botId: "B1", text: "b", subtype: "bot_message", threadTs: null, replyCount: 2, latestReply: "5.0" },
      { ts: "3.0", user: "U2", botId: null, text: "c", subtype: null, threadTs: null, replyCount: 0, latestReply: null },
    ]);
    expect(world.calls[0]!.params).toMatchObject({ channel: "C1", oldest: "1.0", limit: "50", inclusive: "false" });
    expect((await slack.replies("C1", "1.0", "2.0")).map((m) => m.ts)).toEqual(["3.5", "4.0"]);
  });

  it("caches users and channels, names them sensibly and finds permalinks", async () => {
    const world = fakeSlack({
      "users.info": { ok: true, user: { id: "U2", name: "marta.s", real_name: "Marta Silva", is_bot: false, profile: { display_name: "marta" } } },
      "conversations.info": { ok: true, channel: { id: "D1", user: "U2", is_im: true } },
      "chat.getPermalink": { ok: true, permalink: "https://x.slack.com/archives/C1/p1" },
      "conversations.open": { ok: true, channel: { id: "D9" } },
    });
    const slack = createSlack("t", { fetch: world.fetch });
    expect(await slack.userInfo("U2")).toEqual({ id: "U2", name: "marta", isBot: false });
    expect(await slack.userInfo("U2")).toEqual({ id: "U2", name: "marta", isBot: false });
    expect(await slack.channelInfo("D1")).toEqual({ id: "D1", name: "U2", kind: "dm" });
    await slack.channelInfo("D1");
    expect(world.calls.filter((c) => c.method === "users.info")).toHaveLength(1);
    expect(world.calls.filter((c) => c.method === "conversations.info")).toHaveLength(1);
    expect(await slack.permalink("C1", "1.0")).toBe("https://x.slack.com/archives/C1/p1");
    expect(world.calls.at(-1)!.params).toEqual({ channel: "C1", message_ts: "1.0" });
    expect(await slack.openDm("U1")).toBe("D9");
  });

  it("opens the socket with the app-level token", async () => {
    const world = fakeSlack({ "apps.connections.open": { ok: true, url: "wss://wss.slack.com/link/?ticket=1" } });
    expect(await createSlack("xoxp", { fetch: world.fetch }).openSocket("xapp-1")).toBe("wss://wss.slack.com/link/?ticket=1");
    expect(world.calls[0]!.auth).toBe("Bearer xapp-1");
  });
});
