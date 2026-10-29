// The Datadog port over the REST API with plain `fetch`: `DD-API-KEY` and `DD-APPLICATION-KEY`
// headers against `https://api.<site>`, JSON both ways. A 429 waits `X-RateLimit-Reset` seconds
// once, then gives up with a `DatadogError` the pollers recognise; a 5xx or a network failure is
// retried twice with a growing pause; a 401/403 is a `DatadogAuthError` naming the path, since
// Datadog answers a missing application-key scope the same way as a wrong key.
import { z } from "zod";

import {
  type Datadog,
  DatadogAuthError,
  DatadogError,
  type DdErrorLogCluster,
  type DdErrorTrackingIssue,
  type DdIncident,
  type DdMonitorGroup,
} from "../../application/datadog.ts";

export interface DatadogRestOptions {
  apiKey: string;
  appKey: string;
  /** `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com` … */
  site: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  /** Waits for a 429's reset; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** The pauses before the second and third try of a call Datadog or the network failed. */
export const RETRY_BACKOFF_MS = [500, 2_000] as const;
/** The most incidents one list call asks for. */
export const INCIDENT_PAGE = 50;
/** The most monitor groups one search asks for. */
export const MONITOR_PAGE = 100;

const Incidents = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z
        .object({
          public_id: z.number(),
          title: z.string(),
          state: z.string().nullish(),
          severity: z.string().nullish(),
          customer_impacted: z.boolean().nullish(),
          created: z.string(),
          modified: z.string(),
          fields: z
            .object({ state: z.object({ value: z.string().nullish() }).nullish(), severity: z.object({ value: z.string().nullish() }).nullish() })
            .passthrough()
            .nullish(),
        })
        .passthrough(),
    }),
  ),
});
const OPEN_INCIDENT = new Set(["active", "stable"]);

const MonitorGroups = z.object({
  groups: z.array(
    z
      .object({
        monitor_id: z.number(),
        monitor_name: z.string(),
        group: z.string(),
        status: z.string(),
        last_triggered_ts: z.number().nullish(),
      })
      .passthrough(),
  ),
});

export function createDatadog(options: DatadogRestOptions): Datadog {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const site = options.site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const base = `https://api.${site}`;

  async function call<T extends z.ZodType>(method: string, path: string, shape: T, body?: unknown, query?: Record<string, string>): Promise<z.infer<T>> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const request = (): Promise<Response> =>
      doFetch(url.toString(), {
        method,
        headers: {
          "DD-API-KEY": options.apiKey,
          "DD-APPLICATION-KEY": options.appKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    // A 5xx or a dropped connection is tried again, twice, with a pause; the last failure is the one reported.
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await request();
      } catch (error) {
        if (attempt >= RETRY_BACKOFF_MS.length) throw new DatadogError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      if (response.status < 500 || attempt >= RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]!);
    }
    if (response.status === 429) {
      const reset = Number(response.headers.get("X-RateLimit-Reset") ?? "1");
      await sleep((Number.isFinite(reset) ? reset : 1) * 1000);
      response = await request();
      if (response.status === 429) throw new DatadogError(`Datadog rate limit on ${method} ${path}: retry after ${reset}s`, 429);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new DatadogAuthError(`Datadog rejected the keys on ${method} ${path}: the API or application key is wrong or revoked, or the app key lacks the scope this call needs`);
    }
    if (!response.ok) throw new DatadogError(`${method} ${path}: HTTP ${response.status}`, response.status);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new DatadogError(`${method} ${path}: the answer was not JSON`, response.status);
    }
    const parsed = shape.safeParse(parsedJson);
    if (!parsed.success) throw new DatadogError(`${method} ${path}: unexpected answer: ${z.prettifyError(parsed.error)}`, response.status);
    return parsed.data;
  }

  return {
    async incidents(): Promise<DdIncident[]> {
      const page = await call("GET", "api/v2/incidents", Incidents, undefined, { "page[size]": String(INCIDENT_PAGE) });
      return page.data.flatMap((raw): DdIncident[] => {
        const a = raw.attributes;
        const state = a.state ?? a.fields?.state?.value ?? "unknown";
        if (!OPEN_INCIDENT.has(state.toLowerCase())) return [];
        return [
          {
            id: raw.id,
            publicId: a.public_id,
            title: a.title,
            state,
            severity: a.severity ?? a.fields?.severity?.value ?? null,
            customerImpacted: a.customer_impacted ?? false,
            created: a.created,
            modified: a.modified,
          },
        ];
      });
    },

    async alertingMonitors(scope: string): Promise<DdMonitorGroup[]> {
      const query = ['status:(alert OR warn OR "no data")', scope].filter(Boolean).join(" ");
      const result = await call("GET", "api/v1/monitor/groups/search", MonitorGroups, undefined, { query, per_page: String(MONITOR_PAGE) });
      return result.groups.map((g) => ({
        monitorId: g.monitor_id,
        monitorName: g.monitor_name,
        group: g.group,
        status: g.status,
        priority: null,
        lastTriggered: g.last_triggered_ts ? new Date(g.last_triggered_ts * 1000).toISOString() : null,
      }));
    },

    async errorTrackingIssues(): Promise<DdErrorTrackingIssue[]> {
      throw new DatadogError("not implemented yet");
    },

    async errorLogClusters(): Promise<DdErrorLogCluster[]> {
      throw new DatadogError("not implemented yet");
    },

    webUrl: (path) => `https://app.${site}/${path.replace(/^\/+/, "")}`,
  };
}
