// The URL of a card's preview: the repository's `verify.e2e.deploy.url_pattern` filled by the machine from ids it owns (the card's branch, its
// head commit, its id). Nothing a container printed is ever part of it. A branch named to move the host cannot: `{branch}` is lowercased and every
// run of characters outside a-z0-9 becomes `-`, and the result must still be an https URL on a valid host with the pattern's last two labels. Pure.
import { hostPatternProblem } from "@hardness/contracts";

export type PreviewUrl = { ok: true; url: string } | { ok: false; reason: string };

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function previewUrlOf(pattern: string, ids: { branch: string; sha: string; card: string }): PreviewUrl {
  const branch = slug(ids.branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 63));
  const card = slug(ids.card);
  if (!/^[0-9a-f]{7,64}$/.test(ids.sha)) return { ok: false, reason: "the commit is not a sha" };
  if (pattern.includes("{branch}") && branch === "") return { ok: false, reason: "the branch name leaves nothing for {branch}" };
  if (pattern.includes("{card}") && card === "") return { ok: false, reason: "the card id leaves nothing for {card}" };
  const filled = pattern.replace(/\{branch\}/g, branch).replace(/\{short_sha\}/g, ids.sha.slice(0, 7)).replace(/\{sha\}/g, ids.sha).replace(/\{card\}/g, card);
  const patternHost = pattern.slice("https://".length).split("/")[0]!.split(":")[0]!.toLowerCase();
  const tail = patternHost.split(".").slice(-2).join(".");
  if (tail.includes("{")) return { ok: false, reason: "a placeholder is in the last two labels of the host" };
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    return { ok: false, reason: "the filled pattern is not a URL" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { ok: false, reason: "the preview must be a plain https URL" };
  const host = url.hostname;
  if (hostPatternProblem(host) !== null) return { ok: false, reason: `${JSON.stringify(host)} is not a valid host` };
  if (host.split(".").slice(-2).join(".") !== tail) return { ok: false, reason: "the filled host left the pattern's domain" };
  return { ok: true, url: url.origin === `https://${host}` && url.pathname === "/" && !filled.endsWith("/") ? `https://${host}` : `https://${host}${url.pathname}${url.search}` };
}
