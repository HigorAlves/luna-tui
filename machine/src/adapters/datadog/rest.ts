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

const Time = z.union([z.number(), z.string()]);
const ErrorTracking = z.object({
  data: z.array(
    z.object({
      attributes: z.object({ total_count: z.number().nullish() }).passthrough(),
      relationships: z.object({ issue: z.object({ data: z.object({ id: z.string() }) }) }).passthrough(),
    }),
  ),
  included: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        attributes: z
          .object({
            error_message: z.string().nullish(),
            error_type: z.string().nullish(),
            first_seen: Time.nullish(),
            last_seen: Time.nullish(),
            regression: z.unknown().optional(),
            service: z.string().nullish(),
            state: z.string().nullish(),
          })
          .passthrough(),
      }),
    )
    .nullish(),
});
const CLOSED_ISSUE = new Set(["RESOLVED", "IGNORED"]);

const Aggregate = z.object({
  data: z.object({
    buckets: z.array(z.object({ by: z.record(z.string(), z.unknown()), computes: z.record(z.string(), z.unknown()) })),
  }),
});
const LogEvents = z.object({
  data: z.array(
    z.object({
      attributes: z
        .object({
          timestamp: z.string(),
          message: z.string().nullish(),
          tags: z.array(z.string()).nullish(),
          attributes: z.object({ error: z.object({ message: z.string().nullish() }).passthrough().nullish() }).passthrough().nullish(),
        })
        .passthrough(),
    }),
  ),
});

/** Stands for a log with no `@error.kind` in the aggregate; it is searched as `-@error.kind:*` and shown as `-`. */
const MISSING_KIND = "__none__";
/** The most sample messages one log cluster carries. */
export const LOG_SAMPLES = 3;
const SAMPLE_CHARS = 500;
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const term = (v: string) => (/^[\w.\-:/]+$/.test(v) ? v : quote(v));
const joinQuery = (...parts: string[]) => parts.filter(Boolean).join(" ");

function epochMs(iso: string, path: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new DatadogError(`${path}: "${iso}" is not a timestamp`);
  return ms;
}
const isoOf = (t: number | string | null | undefined, fallback: string): string => {
  if (t === null || t === undefined) return fallback;
  return typeof t === "number" ? new Date(t).toISOString() : t;
};

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

    async errorTrackingIssues(scope: string, from: string, to: string): Promise<DdErrorTrackingIssue[]> {
      const path = "api/v2/error-tracking/issues/search";
      const answer = await call(
        "POST",
        path,
        ErrorTracking,
        {
          data: {
            type: "search_request",
            attributes: { query: scope || "*", from: epochMs(from, path), to: epochMs(to, path), persona: "ALL", order_by: "TOTAL_COUNT", states: ["OPEN", "ACKNOWLEDGED"] },
          },
        },
        { include: "issue" },
      );
      const issues = new Map((answer.included ?? []).filter((i) => i.type === "issue").map((i) => [i.id, i.attributes]));
      return answer.data.flatMap((result): DdErrorTrackingIssue[] => {
        const id = result.relationships.issue.data.id;
        const a = issues.get(id);
        if (!a) return [];
        const state = a.state ?? "OPEN";
        if (CLOSED_ISSUE.has(state.toUpperCase())) return [];
        return [
          {
            id,
            errorType: a.error_type ?? "Error",
            errorMessage: a.error_message ?? "",
            service: a.service ?? null,
            env: null,
            state,
            isRegression: Boolean(a.regression),
            count: result.attributes.total_count ?? 0,
            firstSeen: isoOf(a.first_seen, from),
            lastSeen: isoOf(a.last_seen, to),
            repositoryUrl: null,
          },
        ];
      });
    },

    async errorLogClusters(scope: string, from: string, to: string, top: number): Promise<DdErrorLogCluster[]> {
      const base = joinQuery("status:error", scope);
      // A `timeout` status in `meta` still carries the buckets counted so far, so they are kept.
      const agg = await call("POST", "api/v2/logs/analytics/aggregate", Aggregate, {
        filter: { query: base, from, to },
        compute: [{ aggregation: "count", type: "total" }],
        group_by: [
          { facet: "service", limit: top, sort: { type: "measure", aggregation: "count", order: "desc" } },
          { facet: "@error.kind", limit: 3, missing: MISSING_KIND, sort: { type: "measure", aggregation: "count", order: "desc" } },
        ],
      });
      const buckets = agg.data.buckets
        .map((b) => ({ service: String(b.by.service ?? "unknown"), kind: String(b.by["@error.kind"] ?? MISSING_KIND), count: Number(b.computes.c0 ?? 0) }))
        .sort((x, y) => y.count - x.count)
        .slice(0, top);
      return Promise.all(
        buckets.map(async (b): Promise<DdErrorLogCluster> => {
          const q = joinQuery(base, `service:${term(b.service)}`, b.kind === MISSING_KIND ? "-@error.kind:*" : `@error.kind:${quote(b.kind)}`);
          const page = await call("POST", "api/v2/logs/events/search", LogEvents, { filter: { query: q, from, to }, sort: "-timestamp", page: { limit: LOG_SAMPLES } });
          const events = page.data;
          const tag = (name: string) =>
            events
              .flatMap((e) => e.attributes.tags ?? [])
              .find((t) => t.startsWith(`${name}:`))
              ?.slice(name.length + 1) ?? null;
          return {
            service: b.service,
            errorKind: b.kind === MISSING_KIND ? "-" : b.kind,
            env: tag("env"),
            count: b.count,
            firstSeen: events.at(-1)?.attributes.timestamp ?? from,
            lastSeen: events[0]?.attributes.timestamp ?? to,
            samples: events.map((e) => String(e.attributes.attributes?.error?.message ?? e.attributes.message ?? "").slice(0, SAMPLE_CHARS)).filter(Boolean),
            repositoryUrl: tag("git.repository_url"),
          };
        }),
      );
    },

    webUrl: (path) => `https://app.${site}/${path.replace(/^\/+/, "")}`,
  };
}
