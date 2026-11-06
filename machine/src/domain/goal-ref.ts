// The goal a ticket serves, read by the machine and never asked of a model: the epic a Jira ticket sits under,
// else an epic or OKR id written in the text, else `none`. Pure.

const MAX_TEXT = 20_000;
/** `EPIC-12`, `OKR-3`, `KR-2024-Q3-1`: an id the team writes down. Bounded length, no backtracking. */
const GOAL_ID = /\b(?:EPIC|OKR|KR|GOAL)-[A-Za-z0-9]{1,12}(?:-[A-Za-z0-9]{1,12}){0,3}\b/;
/** A Jira key, as an epic link carries it. */
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

export function goalRefOf(input: { text: string; epicKey?: string | null }): string {
  if (input.epicKey && JIRA_KEY.test(input.epicKey)) return input.epicKey;
  const hit = GOAL_ID.exec(input.text.slice(0, MAX_TEXT));
  return hit ? hit[0].toUpperCase() : "none";
}
