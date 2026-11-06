// What the machine may post outward from text a model or a person wrote: one line, no HTML, no `@mention`, no `#N`
// auto-link, capped, and never a token-shaped string, never a company memory item's marker. One implementation for every outward post (the review loop's
// replies, a conversation's reply, triage's questions).
import { carriesCompanyMarker, COMPANY_MARKER_PATTERN } from "@hardness/contracts";

import { holdsForeignAddress } from "./address-rule.ts";
import { redact, safe } from "./evidence-markdown.ts";

/** The longest a reply the machine posts may be, after flattening. */
export const REPLY_CAP = 1500;

/** A model's text made safe to post: one line, no HTML, no `@mention`, no `#N` auto-link, capped. */
export const postable = (text: string, cap = REPLY_CAP): string => safe(flattenLinks(stripCompanyMarkers(text))).slice(0, cap).trim();

/** The marker of a company memory item (`luna:co_...`) removed: company documents never leave the machine in a public post (RFC 0007). */
export const stripCompanyMarkers = (text: string): string => text.replace(COMPANY_MARKER_PATTERN, "");

/** A Markdown image is dropped and a link keeps its address in the open (`[label](url)` becomes `label (url)`): GitHub would render
 *  both, and a model's or a stranger's text does not get a clickable label that hides where it goes. Bounded, so no run backtracks.
 *  This is the tidy reading of the common shapes; `safe()` breaks whatever link syntax is left (a label over two lines, nested brackets). */
export function flattenLinks(text: string): string {
  return text.replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,2000}\)/g, "").replace(/\[([^\]\n]{0,300})\]\(([^)\n]{0,2000})\)/g, "$1 ($2)");
}

/** Whether the text carried a token-shaped string: such a drafted text is never posted. */
export const carriesSecret = (text: string): boolean => redact(text) !== text;

/** A reply the machine built itself from fixed words and its own board link (the merged-card notice): `mergedNotice` flattened its words already, and
 *  flattening it again would break the link it is there to carry. Anything else a person or a model wrote goes through `postable`. */
export const isMachineNotice = (payload: Record<string, unknown>): boolean => payload.by === "machine" && payload.kind === "merged";

const PLAIN_ADDRESS = /^https?:\/\/[^\s<>"'`\u0000-\u001f]{1,500}$/i;

/** `postable`, with the addresses the machine itself supplied (the card's own PR link) printed whole, so they stay clickable: `safe()` breaks every address, and each
 *  `given` one is put back exactly as given, only where it stands in the text as the machine wrote it. Any other address stays broken. A `given` value that is not a
 *  plain web address is ignored. The caller has already refused a text that holds an address the machine did not give. */
export function postableKeeping(text: string, given: Iterable<string>, cap = REPLY_CAP): string {
  let out = postable(text, cap);
  for (const link of given) {
    if (!PLAIN_ADDRESS.test(link)) continue;
    const broken = safe(flattenLinks(link));
    if (broken !== link) out = out.split(broken).join(link);
  }
  return out;
}

/** The one rule for a conversation draft's addresses, used where the draft is written and where it is sent: the text holds no address but the exact `given` ones (the
 *  card's own PR link, as the machine supplied it; `files` are the file names of the docs the machine supplied), else it is dropped (`null`); what is left is
 *  `postableKeeping`. A draft sent as drafted must equal this function's answer for the same `given`, so the send path is never looser or stricter than the drafting one. */
export function postableDraft(text: string, given: Iterable<string>, files: Iterable<string> = []): string | null {
  const links = [...given];
  if (carriesCompanyMarker(text)) return null;
  if (holdsForeignAddress(text, { given: links, files })) return null;
  return postableKeeping(text, links);
}
