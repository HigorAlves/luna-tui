// The Datadog port: what incident detection asks Datadog, as typed calls over your API and
// application keys. The REST adapter implements it; tests pass a fake. Every method throws a
// `DatadogError` when a call fails; a caller backs off on a 429.

import { webHost } from "../domain/datadog-site.ts";

export class DatadogError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DatadogError";
  }
}

/** 401/403: the keys are wrong, revoked, or the app key lacks a scope. */
export class DatadogAuthError extends DatadogError {
  constructor(message: string) {
    super(message, 401);
    this.name = "DatadogAuthError";
  }
}

/** A list that may have stopped at the adapter's page cap: `incomplete` then says "more exist than you got". */
export type Listing<T> = T[] & { incomplete?: boolean };

export interface DdIncident {
  id: string;
  publicId: number;
  title: string;
  /** `active` | `stable` | `resolved` … */
  state: string;
  /** `SEV-1` … `SEV-5`, `UNKNOWN`. */
  severity: string | null;
  customerImpacted: boolean;
  created: string;
  modified: string;
}

export interface DdMonitorGroup {
  monitorId: number;
  monitorName: string;
  /** `service:api,env:prod`, or `*` for a monitor without groups. */
  group: string;
  /** `Alert` | `Warn` | `No Data`. */
  status: string;
  /** The monitor's priority, 1 (highest) to 5, or null. */
  priority: number | null;
  lastTriggered: string | null;
}

export interface DdErrorTrackingIssue {
  id: string;
  errorType: string;
  errorMessage: string;
  service: string | null;
  env: string | null;
  /** `OPEN` | `ACKNOWLEDGED` | `RESOLVED` … */
  state: string;
  isRegression: boolean;
  count: number;
  firstSeen: string;
  lastSeen: string;
  repositoryUrl: string | null;
}

export interface Datadog {
  /** Incidents not yet resolved (`active`, `stable`). */
  incidents(): Promise<Listing<DdIncident>>;
  /** Monitor groups in Alert, Warn or No Data, narrowed by `scope` (e.g. `env:prod`). */
  alertingMonitors(scope: string): Promise<Listing<DdMonitorGroup>>;
  /** Error Tracking issues seen between `from` and `to` (ISO), open ones only. */
  errorTrackingIssues(scope: string, from: string, to: string): Promise<DdErrorTrackingIssue[]>;
  /** Where a link to `path` on the Datadog web app points: `https://app.<site>/<path>`. */
  webUrl(path: string): string;
}

/** No keys are set: nothing can be read. Every call refuses with this reason. */
export class NoDatadogTokenError extends DatadogError {
  constructor() {
    super("no Datadog keys: set MACHINE_DATADOG_API_KEY and MACHINE_DATADOG_APP_KEY for Datadog incidents");
    this.name = "NoDatadogTokenError";
  }
}

/** The port with no keys behind it: every call fails with the same clear reason. */
export function noTokenDatadog(site = "datadoghq.com"): Datadog {
  const refuse = () => Promise.reject(new NoDatadogTokenError());
  return {
    incidents: refuse,
    alertingMonitors: refuse,
    errorTrackingIssues: refuse,
    webUrl: (path) => `https://${webHost(site)}/${path.replace(/^\/+/, "")}`,
  };
}
