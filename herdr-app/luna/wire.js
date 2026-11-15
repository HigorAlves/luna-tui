// The machine's event stream, read off a raw socket: the HTTP head, chunked framing and SSE
// messages. Herdr's `fetch` answers whole bodies only, so the stream is read with `net` and
// parsed here. Bytes in, messages out; no host calls, so `node --test` checks every part.

const CR = 13;
const LF = 10;

function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index of `\r\n` at or after `from`, or -1. */
function crlf(bytes, from) {
  for (let i = from; i + 1 < bytes.length; i++) if (bytes[i] === CR && bytes[i + 1] === LF) return i;
  return -1;
}

const ascii = (bytes) => String.fromCharCode(...bytes);

/**
 * The response head: status and headers, once `\r\n\r\n` arrived. `push` answers null until then;
 * after, `{status, headers, rest}`, `rest` being the body bytes that came with the head.
 */
export class Head {
  constructor() {
    this.bytes = new Uint8Array(0);
  }

  push(chunk) {
    this.bytes = concat(this.bytes, chunk);
    for (let i = 0; i + 3 < this.bytes.length; i++) {
      if (this.bytes[i] === CR && this.bytes[i + 1] === LF && this.bytes[i + 2] === CR && this.bytes[i + 3] === LF) {
        const lines = ascii(this.bytes.subarray(0, i)).split("\r\n");
        const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
        const headers = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        return { status, headers, rest: this.bytes.subarray(i + 4) };
      }
    }
    return null;
  }
}

/** Undoes `Transfer-Encoding: chunked`: the payload bytes of every complete chunk so far. `done` once the last (empty) chunk came. */
export class Dechunker {
  constructor() {
    this.bytes = new Uint8Array(0);
    this.done = false;
  }

  push(chunk) {
    this.bytes = concat(this.bytes, chunk);
    let out = new Uint8Array(0);
    for (;;) {
      const end = crlf(this.bytes, 0);
      if (end < 0) break;
      const size = parseInt(ascii(this.bytes.subarray(0, end)).split(";")[0].trim(), 16);
      if (Number.isNaN(size)) {
        // Not chunked framing after all: hand the bytes on as they are.
        out = concat(out, this.bytes);
        this.bytes = new Uint8Array(0);
        break;
      }
      const start = end + 2;
      if (size === 0) {
        this.done = true;
        this.bytes = new Uint8Array(0);
        break;
      }
      if (this.bytes.length < start + size + 2) break;
      out = concat(out, this.bytes.subarray(start, start + size));
      this.bytes = this.bytes.subarray(start + size + 2);
    }
    return out;
  }
}

/**
 * SSE messages from body bytes. Messages end at a blank line; a message is split on bytes, not
 * text, so a multi-byte character cut across two reads is decoded whole. `decode` turns bytes into
 * text (Herdr's `Buffer`, or Node's). Comments (`: ping`) and messages with no data are dropped.
 */
export class Sse {
  constructor(decode) {
    this.decode = decode;
    this.bytes = new Uint8Array(0);
  }

  push(chunk) {
    this.bytes = concat(this.bytes, chunk);
    const messages = [];
    for (;;) {
      const end = this.blank();
      if (!end) break;
      const text = this.decode(this.bytes.subarray(0, end.at));
      this.bytes = this.bytes.subarray(end.at + end.length);
      const message = parseMessage(text);
      if (message) messages.push(message);
    }
    return messages;
  }

  /** Where the first blank line is: `\n\n`, `\r\n\r\n` or `\r\r`. */
  blank() {
    const b = this.bytes;
    for (let i = 0; i + 1 < b.length; i++) {
      if (b[i] === LF && b[i + 1] === LF) return { at: i, length: 2 };
      if (b[i] === CR && b[i + 1] === LF && b[i + 2] === CR && b[i + 3] === LF) return { at: i, length: 4 };
      if (b[i] === CR && b[i + 1] === CR) return { at: i, length: 2 };
    }
    return null;
  }
}

/** One SSE block as `{event, data, id}`: `event` defaults to `message`, `data` lines are joined with `\n`. */
export function parseMessage(text) {
  let event = "message";
  let id = null;
  const data = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (!raw || raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return null;
  return { event, data: data.join("\n"), id };
}

/** The request line and headers for `GET path`, as one string. */
export function request(path, { host, token }) {
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, "Accept: text/event-stream", "Cache-Control: no-cache", "Connection: keep-alive"];
  if (token) lines.push(`Authorization: Bearer ${token}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}
