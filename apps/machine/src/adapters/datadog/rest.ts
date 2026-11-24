// The Datadog port over the REST API with plain `fetch`: `DD-API-KEY` and `DD-APPLICATION-KEY`
// headers against `https://api.<site>`, JSON both ways. A 429 whose `X-RateLimit-Reset` is within 5s waits
// once, a longer one gives up at once, and a second 429 gives up too, with a `DatadogError` the pollers recognise; a 5xx or a network failure is
// retried twice with a growing pause; a 401/403 is a `DatadogAuthError` naming the path, since
// Datadog answers a missing application-key scope the same way as a wrong key.
import { z } from "zod";

import {
  type Datadog,
  DatadogAuthError,
  DatadogError,
  type DdErrorTrackingIssue,
  type DdIncident,
  type DdMonitorGroup,
  type Listing,
} from "../../application/datadog.ts";
import { normaliseSite, webHost } from "../../domain/datadog-site.ts";

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
export const INCIDENT_PAGE = 100;
/** The most monitor groups one search asks for. */
export const MONITOR_PAGE = 100;
/** The most pages one incident or monitor listing follows before it reports itself incomplete. */
export const MAX_PAGES = 10;
/** A 429 whose reset is further off than this is not waited out: the poller backs off instead. */
export const MAX_RATE_WAIT_S = 5;

const IncidentData = z.object({
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
});
// GET api/v2/incidents/search: the incident objects sit one level down, in data.attributes.incidents[].data.
const Incidents = z.object({
  data: z.object({ attributes: z.object({ incidents: z.array(z.object({ data: IncidentData })) }).passthrough() }).passthrough(),
  meta: z.object({ pagination: z.object({ next_offset: z.number().nullish() }).nullish() }).nullish(),
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
  metadata: z.object({ page: z.number().nullish(), page_count: z.number().nullish(), page_size: z.number().nullish(), total_count: z.number().nullish() }).nullish(),
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

function epochMs(iso: string, path: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new DatadogError(`${path}: "${iso}" is not a timestamp`);
  return ms;
}
const isoOf = (t: number | string | null | undefined, fallback: string): string => {
  if (t === null || t === undefined) return fallback;
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
};

export function createDatadog(options: DatadogRestOptions): Datadog {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const site = normaliseSite(options.site);
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
      const wait = Number.isFinite(reset) ? reset : 1;
      if (wait > MAX_RATE_WAIT_S) throw new DatadogError(`Datadog rate limit on ${method} ${path}: retry after ${wait}s`, 429);
      await sleep(wait * 1000);
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
    async incidents(): Promise<Listing<DdIncident>> {
      const out: Listing<DdIncident> = [];
      let offset = 0;
      for (let pages = 0; ; pages++) {
        const page = await call("GET", "api/v2/incidents/search", Incidents, undefined, {
          query: "state:(active OR stable)",
          sort: "-created",
          "page[size]": String(INCIDENT_PAGE),
          "page[offset]": String(offset),
        });
        const found = page.data.attributes.incidents;
        for (const { data: raw } of found) {
          const a = raw.attributes;
          const state = a.state ?? a.fields?.state?.value ?? "unknown";
          if (!OPEN_INCIDENT.has(state.toLowerCase())) continue;
          out.push({
            id: raw.id,
            publicId: a.public_id,
            title: a.title,
            state,
            severity: a.severity ?? a.fields?.severity?.value ?? null,
            customerImpacted: a.customer_impacted ?? false,
            created: a.created,
            modified: a.modified,
          });
        }
        const next = page.meta?.pagination?.next_offset;
        if (found.length < INCIDENT_PAGE || next === null || next === undefined || next <= offset) break;
        if (pages + 1 >= MAX_PAGES) {
          out.incomplete = true;
          break;
        }
        offset = next;
      }
      return out;
    },

    async alertingMonitors(scope: string): Promise<Listing<DdMonitorGroup>> {
      const query = ['status:(alert OR warn OR "no data")', scope].filter(Boolean).join(" ");
      const out: Listing<DdMonitorGroup> = [];
      for (let pageNo = 0; ; pageNo++) {
        const result = await call("GET", "api/v1/monitor/groups/search", MonitorGroups, undefined, { query, per_page: String(MONITOR_PAGE), page: String(pageNo) });
        for (const g of result.groups) {
          out.push({
            monitorId: g.monitor_id,
            monitorName: g.monitor_name,
            group: g.group,
            status: g.status,
            priority: null,
            lastTriggered: g.last_triggered_ts ? new Date(g.last_triggered_ts * 1000).toISOString() : null,
          });
        }
        const m = result.metadata;
        const pageCount = m?.page_count ?? (m?.total_count != null ? Math.ceil(m.total_count / (m.page_size ?? MONITOR_PAGE)) : 1);
        if (pageNo + 1 >= pageCount || result.groups.length === 0) break;
        if (pageNo + 1 >= MAX_PAGES) {
          out.incomplete = true;
          break;
        }
      }
      return out;
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

    webUrl: (path) => `https://${webHost(site)}/${path.replace(/^\/+/, "")}`,
  };
}
