import assert from "node:assert/strict";
import { test } from "node:test";

import { Dechunker, Head, Sse, parseMessage, request } from "../luna/wire.js";

const bytes = (text) => new TextEncoder().encode(text);
const decode = (b) => new TextDecoder().decode(b);

test("the head waits for the blank line, then gives the status, headers and the body that came with it", () => {
  const head = new Head();
  assert.equal(head.push(bytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n")), null);
  const got = head.push(bytes("Transfer-Encoding: chunked\r\n\r\n5\r\nhello"));
  assert.equal(got.status, 200);
  assert.equal(got.headers["content-type"], "text/event-stream");
  assert.equal(got.headers["transfer-encoding"], "chunked");
  assert.equal(decode(got.rest), "5\r\nhello");
});

test("a 401 head is read as a 401", () => {
  assert.equal(new Head().push(bytes("HTTP/1.1 401 Unauthorized\r\n\r\n")).status, 401);
});

test("chunks are joined across reads, and a chunk cut in half waits for its end", () => {
  const d = new Dechunker();
  assert.equal(decode(d.push(bytes("5\r\nhel"))), "");
  assert.equal(decode(d.push(bytes("lo\r\n6\r\n world\r\n"))), "hello world");
  assert.equal(d.done, false);
  d.push(bytes("0\r\n\r\n"));
  assert.equal(d.done, true);
});

test("a chunk size with an extension is read", () => {
  assert.equal(decode(new Dechunker().push(bytes("3;name=x\r\nabc\r\n"))), "abc");
});

test("SSE messages split on the blank line, comments dropped", () => {
  const sse = new Sse(decode);
  assert.deepEqual(sse.push(bytes(": ping\n\nevent: task.updated\ndata: {\"id\":\"a\"}\n\nevent: rea")), [
    { event: "task.updated", data: "{\"id\":\"a\"}", id: null },
  ]);
  assert.deepEqual(sse.push(bytes("dy\ndata: {}\n\n")), [{ event: "ready", data: "{}", id: null }]);
});

test("a multi-byte character cut across two reads is decoded whole", () => {
  const sse = new Sse(decode);
  const all = bytes("data: café ✓\n\n");
  const cut = all.length - 5;
  assert.deepEqual(sse.push(all.subarray(0, cut)), []);
  assert.deepEqual(sse.push(all.subarray(cut)), [{ event: "message", data: "café ✓", id: null }]);
});

test("CRLF line ends and several data lines are read", () => {
  assert.deepEqual(new Sse(decode).push(bytes("id: 7\r\ndata: a\r\ndata: b\r\n\r\n")), [{ event: "message", data: "a\nb", id: "7" }]);
});

test("a message with no data is no message", () => {
  assert.equal(parseMessage("event: ping"), null);
});

test("the request carries the token only when there is one", () => {
  const withToken = request("/events?since=4", { host: "127.0.0.1:4318", token: "t" });
  assert.match(withToken, /^GET \/events\?since=4 HTTP\/1.1\r\nHost: 127.0.0.1:4318\r\n/);
  assert.match(withToken, /Authorization: Bearer t\r\n\r\n$/);
  assert.doesNotMatch(request("/events", { host: "h", token: null }), /Authorization/);
});
