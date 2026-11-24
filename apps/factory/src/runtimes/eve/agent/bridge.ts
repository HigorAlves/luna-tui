// One call to the runner's bridge (run.ts) with the run's bearer token. node:http, not fetch:
// a delegated helper takes minutes, past fetch's own header and body timeouts.
import { request } from "node:http";

import { secrets } from "./secrets.ts";

/** POST /<name> with `input` as JSON; the JSON answer. `timeoutMs` bounds the whole call (none by default). */
export function bridge(name: string, input: unknown, timeoutMs?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(`${process.env.LUNA_EVE_BRIDGE_URL}/${name}`, { method: "POST", headers: { authorization: `Bearer ${secrets().bridgeToken}`, "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`luna ${name}: the runner answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(text) as unknown);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    req.on("error", reject);
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error(`luna ${name}: no answer in ${timeoutMs} ms`)));
    req.end(JSON.stringify(input));
  });
}
