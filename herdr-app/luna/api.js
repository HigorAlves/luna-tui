// The machine, as the board sees it: the same URL rule and token as the Rust board
// (`HARDNESS_MACHINE_URL`, else the dev machine on 4317, then the Docker one on 4318;
// `MACHINE_API_TOKEN`, else ~/.config/hardness/machine-api-token), JSON calls through `fetch`,
// and the `/events` stream read off a socket (wire.js). The token is never shown.
import { exec, readTextFile, home } from "herdr";
import net from "net";
import { Buffer } from "buffer";

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

export class Machine {
  constructor() {
    this.base = null;
    this.token = null;
    this.approver = null;
    this.ready = null;
  }

  /** Reads the settings once and picks the machine that answers; later calls wait for it. */
  connect() {
    this.ready ??= this.pick();
    return this.ready;
  }

  /** Picks again (the machine moved between `pnpm dev` and `pnpm start`). */
  reconnect() {
    this.ready = this.pick();
    return this.ready;
  }

  async pick() {
    const [url, token, approver] = await Promise.all([env("HARDNESS_MACHINE_URL"), env("MACHINE_API_TOKEN"), env("LUNA_APPROVER")]);
    const file = token ? null : await readTextFile(`${home()}/.config/hardness/machine-api-token`).catch(() => null);
    this.token = (token ?? file ?? "").replace(/\s+/g, "") || null;
    this.approver = approver;
    const list = url ? [url.replace(/\/+$/, "")] : CANDIDATES;
    for (const base of list) {
      try {
        const r = await fetch(`${base}/health`, { headers: this.headers() });
        // A machine with problems answers 503: it is up, and the one to talk to.
        if (r.ok || r.status === 503) {
          this.base = base;
          return base;
        }
      } catch {
        // not this one
      }
    }
    this.base = list.at(-1);
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
  decide(id, decision, extra = {}) {
    const body = { decision, ...extra };
    if (this.approver && decision === "approved") body.approver = this.approver;
    return this.post(`/tasks/${enc(id)}/decision`, body);
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
   * stop; each message goes to `onMessage({event, data})`, `data` parsed. Resolves when it ends,
   * rejects when it cannot connect or the machine refuses.
   */
  async follow(since, onMessage, alive) {
    await this.connect();
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(this.base ?? "");
    if (!m) throw new MachineError(`not a machine URL: ${this.base}`);
    const host = m[1];
    const port = Number(m[2] ?? 80);
    const socket = await net.connect(host, port);
    try {
      await socket.write(request(`/events${since != null ? `?since=${since}` : ""}`, { host: `${host}:${port}`, token: this.token }));
      const head = new Head();
      const chunks = new Dechunker();
      const sse = new Sse((b) => Buffer.from(b).toString("utf8"));
      let got = null;
      while (alive()) {
        const bytes = await socket.read(65536);
        if (bytes == null) break;
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
      socket.close();
    }
  }
}
