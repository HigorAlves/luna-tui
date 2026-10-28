// Slack's mrkdwn turned into plain text for the row, the pane and the model: user, channel,
// usergroup and broadcast tokens become their names, links become their labels, and the three
// HTML escapes Slack applies are undone. Formatting marks (*bold*, _italic_) are left as is.

/** Names a user id; undefined keeps the id. */
export type NameResolver = (userId: string) => string | undefined;

export function toPlainText(text: string, resolve: NameResolver = () => undefined): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label: string | undefined) => `@${label || resolve(id) || id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, _id: string, name: string) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, (_m, id: string) => `#${id}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, (_m, handle: string) => (handle.startsWith("@") ? handle : `@${handle}`))
    .replace(/<!subteam\^([A-Z0-9]+)>/g, (_m, id: string) => `@${id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, word: string) => `@${word}`)
    .replace(/<!date\^\d+\^[^|>]*(?:\|([^>]*))?>/g, (_m, fallback: string | undefined) => fallback ?? "")
    .replace(/<((?:https?|mailto):[^|>]*)\|([^>]*)>/g, (_m, _url: string, label: string) => label)
    .replace(/<((?:https?|mailto):[^>]*)>/g, (_m, url: string) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Text you typed, made safe to post as mrkdwn: `&`, `<` and `>` cannot open a mention, a link or a command. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
