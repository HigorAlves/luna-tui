// Datadog site names: how a configured site is cleaned up and which host serves its web app.

/** Strips a scheme, an `api.`/`app.` prefix and trailing slashes: `https://api.datadoghq.eu/` becomes `datadoghq.eu`. */
export function normaliseSite(site: string): string {
  return site.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^(?:api|app)\./, "");
}

/** The web app's host: regional sites (`us5.datadoghq.com`) are their own app host, the others are `app.<site>`. */
export function webHost(site: string): string {
  const s = normaliseSite(site);
  return /^[a-z0-9]+\.datadoghq\.com$/.test(s) ? s : `app.${s}`;
}
