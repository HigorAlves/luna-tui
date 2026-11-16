// The Sentry port: what incident detection asks Sentry, as one typed call over an auth token. The REST
// adapter implements it; tests pass a fake. The call throws a `SentryError` when it fails; a caller backs off on a 429.

export class SentryError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "SentryError";
  }
}

/** 401/403: the token is wrong, revoked, or lacks a scope. */
export class SentryAuthError extends SentryError {
  constructor(message: string, status = 401) {
    super(message, status);
    this.name = "SentryAuthError";
  }
}

/** A list that may have stopped at the adapter's page cap: `incomplete` then says "more exist than you got". */
export type Listing<T> = T[] & { incomplete?: boolean };

export interface SentryIssue {
  id: string;
  /** `API-GATEWAY-3F`. */
  shortId: string;
  title: string;
  culprit: string;
  /** `fatal` | `error` | `warning` | `info` | `debug` … */
  level: string;
  /** `unresolved` | `resolved` | `ignored` … */
  status: string;
  /** Events seen. */
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  /** The project's slug. */
  project: string;
}

export interface Sentry {
  /** Unresolved issues of the organization (and its configured projects) first seen at or after `since` (ISO), or escalating, active up to now. */
  newOrEscalatingIssues(since: string): Promise<Listing<SentryIssue>>;
}

/** No token or organization is set: nothing can be read. */
export class NoSentryTokenError extends SentryError {
  constructor() {
    super("no Sentry token: set MACHINE_SENTRY_TOKEN and MACHINE_SENTRY_ORG for Sentry incidents");
    this.name = "NoSentryTokenError";
  }
}

/** The port with no token behind it: every call fails with the same clear reason. */
export function noTokenSentry(): Sentry {
  return { newOrEscalatingIssues: () => Promise.reject(new NoSentryTokenError()) };
}
