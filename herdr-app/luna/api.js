// The machine, as the board sees it: the same URL rule and token as the Rust board
// (`HARDNESS_MACHINE_URL`, else the dev machine on 4317, then the Docker one on 4318;
// `MACHINE_API_TOKEN`, else ~/.config/hardness/machine-api-token), JSON calls through `fetch`,
// and the `/events` stream read off a socket (wire.js). The token is never shown.
import { exec, readTextFile, home } from "herdr";
import net from "net";
import { Buffer } from "buffer";

import { gateKey, gateQuestion, stageWords } from "./model.js";
import { Dechunker, Head, Sse, request } from "./wire.js";

const CANDIDATES = ["http://127.0.0.1:4317", "http://127.0.0.1:4318"];

/** A machine refusal: its `error` code, HTTP status and whole body beside the message. */
export class MachineError extends Error {
  constructor(message, { code = null, status = 0, body = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

async function env(name) {
  try {
    const r = await exec("printenv", [name], { timeout: 5000 });
    const value = r.code === 0 ? r.stdout.trim() : "";
    return value || null;
  } catch {
    return null;
  }
}

const enc = encodeURIComponent;

const PROBE_MS = 800;
const WATCHDOG_MS = 40000;
const CONNECT_MS = 5000;

/**
 * `promise`, or a rejection once `ms` passed (the timer is the task's own `cx.timer`: Herdr has no
 * `setTimeout`). Without a `cx` there is nothing to time with and the promise is returned as is.
 */
export function within(cx, ms, promise, what, code = "timeout") {
  if (!cx?.timer) return promise;
  return new Promise((resolve, reject) => {
    let over = false;
    const timer = cx.timer.after(ms, () => {
      over = true;
      reject(new MachineError(`${what} did not answer in ${ms / 1000}s`, { code }));
    });
    promise.then(
      (v) => {
        if (!over) {
          timer.cancel();
          resolve(v);
        }
      },
      (e) => {
        if (!over) {
          timer.cancel();
          reject(e);
        }
      },
    );
  });
}

export class Machine {
  /** `cx` (an AsyncContext, valid across awaits) times the probes and the stream; `net` is the socket module. */
  constructor({ cx = null, net: socketModule = net } = {}) {
    this.cx = cx;
    this.net = socketModule;
    this.base = null;
    this.token = null;
    this.approver = null;
    this.ready = null;
    this.settingsReady = null;
    this.watchdogMs = WATCHDOG_MS;
  }

  /** The env and the token, read once for the pane: a retry never runs `printenv` again. */
  loadSettings() {
    this.settingsReady ??= (async () => {
      const [url, token, approver] = await Promise.all([env("HARDNESS_MACHINE_URL"), env("MACHINE_API_TOKEN"), env("LUNA_APPROVER")]);
      const file = token ? null : await readTextFile(`${home()}/.config/hardness/machine-api-token`).catch(() => null);
      return { url: url ? url.replace(/\/+$/, "") : null, token: (token ?? file ?? "").replace(/\s+/g, "") || null, approver };
    })();
    return this.settingsReady;
  }

  /** Reads the settings once and picks the machine that answers; later calls wait for it. */
  connect() {
    this.ready ??= this.pick();
    return this.ready;
  }

  /** Picks again (the machine moved between `pnpm dev` and `pnpm start`); the settings stay. */
  reconnect() {
    this.ready = this.pick();
    return this.ready;
  }

  async pick() {
    const settings = await this.loadSettings();
    this.token = settings.token;
    this.approver = settings.approver;
    const list = settings.url ? [settings.url] : CANDIDATES;
    for (const base of list) {
      try {
        const r = await within(this.cx, PROBE_MS, fetch(`${base}/health`, { headers: this.headers() }), `${base}/health`);
        // A machine with problems answers 503: it is up, and the one to talk to.
        if (r.ok || r.status === 503) {
          this.base = base;
          return base;
        }
      } catch {
        // not this one
      }
    }
    // None answered: stay on the first, as the TUI does, so the error names where it looked first.
    this.base = list[0];
    throw new MachineError(`no machine answers at ${list.join(" or ")}: start it with pnpm start`);
  }

  headers(json = false) {
    const h = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async call(method, path, body) {
    await this.connect().catch(() => null);
    let r;
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new MachineError(`machine unreachable: ${e?.message ?? e}`);
    }
    if (r.status === 204) return null;
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!r.ok) throw new MachineError(json?.message ?? `${method} ${path} answered ${r.status}`, { code: json?.error ?? null, status: r.status, body: json });
    return json;
  }

  get(path) { return this.call("GET", path); }
  post(path, body = {}) { return this.call("POST", path, body); }
  patch(path, body) { return this.call("PATCH", path, body); }
  del(path) { return this.call("DELETE", path); }

  // The board's calls, named for what they do.
  tasks() { return this.get("/tasks"); }
  health() { return this.get("/health").catch((e) => (e.status === 503 ? e.body : Promise.reject(e))); }
  detail(id) { return this.get(`/tasks/${enc(id)}`); }
  diff(id, file) { return this.get(`/tasks/${enc(id)}/diff${file ? `?file=${enc(file)}` : ""}`); }
  create(input) { return this.post("/tasks", input); }
  start(id) { return this.post(`/tasks/${enc(id)}/start`); }
  /** A decision. Connected first, so the approver's name (LUNA_APPROVER) rides on every one, as in the TUI. */
  async decide(id, decision, extra = {}) {
    await this.connect().catch(() => null);
    const body = { decision, ...extra };
    if (this.approver && body.approver == null) body.approver = this.approver;
    return this.post(`/tasks/${enc(id)}/decision`, body);
  }

  /**
   * A decision sent only if the card still waits on what the dialog asked about (`expect` is
   * `gateKey(task)` from when it opened); otherwise a `moved` refusal that says what it waits on now.
   */
  async decideIfStill(id, expect, decision, extra = {}) {
    const now = await this.detail(id);
    const task = now?.task ?? now;
    if (gateKey(task) !== expect) {
      const words = gateQuestion(task) ?? stageWords(task?.state);
      throw new MachineError(`It moved on: ${words}`, { code: "moved" });
    }
    return this.decide(id, decision, extra);
  }
  answer(id, answers) { return this.post(`/tasks/${enc(id)}/answers`, { answers }); }
  postQuestions(id) { return this.post(`/tasks/${enc(id)}/questions/post`); }
  context(id, given) { return this.post(`/tasks/${enc(id)}/context`, given); }
  dedup(id, choice, of) { return this.post(`/tasks/${enc(id)}/dedup`, { choice, of }); }
  abort(id) { return this.post(`/tasks/${enc(id)}/abort`); }
  resume(id) { return this.post(`/tasks/${enc(id)}/resume`); }
  archive(id, reason) { return this.post(`/tasks/${enc(id)}/archive`, { reason }); }
  remove(id) { return this.del(`/tasks/${enc(id)}`); }
  prs(all = false) { return this.get(all ? "/github/prs/all" : "/github/prs"); }
  refreshPrs(all = false) { return this.post(all ? "/github/prs/all/refresh" : "/github/prs/refresh"); }
  prAction(repo, number, action) { return this.post(`/github/prs/${repo}/${number}/actions`, { action }); }
  mergePr(repo, number) { return this.post(`/github/prs/${repo}/${number}/merge`); }
  clone(repo, dest) { return this.post("/github/clone", { repo, dest }); }

  /**
   * Follows `/events` (from `since` when given) until the connection ends or `alive()` says
   * stop; each message goes to `onMessage({event, data})`, `data` parsed, and `onBytes()` hears
   * every read. Resolves when it ends, rejects when it cannot connect, the machine refuses, or
   * nothing (not even the machine's 15s ping) came for `watchdogMs`: a read never hangs the loop.
   */
  async follow(since, onMessage, alive, { onBytes = null } = {}) {
    await this.connect();
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(this.base ?? "");
    if (!m) throw new MachineError(`not a machine URL: ${this.base}`);
    if (m[1] === "https") throw new MachineError("the live stream is not supported over https: the board polls instead", { code: "tls" });
    const host = m[2];
    const port = Number(m[3] ?? 80);
    const socket = await within(this.cx, CONNECT_MS, this.net.connect(host, port), `${host}:${port}`);
    try {
      await within(this.cx, CONNECT_MS, socket.write(request(`/events${since != null ? `?since=${since}` : ""}`, { host: `${host}:${port}`, token: this.token })), "the stream request");
      const head = new Head();
      const chunks = new Dechunker();
      const sse = new Sse((b) => Buffer.from(b).toString("utf8"));
      let got = null;
      while (alive()) {
        const bytes = await within(this.cx, this.watchdogMs, socket.read(65536), "the event stream", "stalled");
        if (bytes == null) break;
        onBytes?.();
        let body = bytes;
        if (!got) {
          got = head.push(bytes);
          if (!got) continue;
          if (got.status !== 200) throw new MachineError(`the event stream answered ${got.status}`, { status: got.status });
          body = got.rest;
        }
        const payload = /chunked/i.test(got.headers["transfer-encoding"] ?? "") ? chunks.push(body) : body;
        for (const message of sse.push(payload)) {
          let data = message.data;
          try {
            data = JSON.parse(message.data);
          } catch {
            // a plain-text message
          }
          onMessage({ event: message.event, data });
        }
        if (chunks.done) break;
      }
    } finally {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
  }
}
