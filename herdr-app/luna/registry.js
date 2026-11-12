// Where features plug in. Each feature file adds to these at load, and features.js imports every
// feature file once, so main.js, the sidebar, the inspector and the dialogs find them without
// knowing them. A feature keeps its own state in `app.state(<its id>)`.
//
// PAGES    {id, label, icon, hidden?: true (stream-only, not in the sidebar), group?: "work" | "inbox" | "insight", render(app, t), enter?(app, cx),
//           keys?: [{name, rows: [[keys, does]]}] (listed in the keys sheet on that page),
//           onMessage?(app, {event, data}, cx) -> true when it used it, badge?(app) -> {n, tone} | null,
//           key?(app, e, cx) -> true when it handled the key}
// TABS     inspector tabs: {id, label, order, count?(app, task, detail), render(app, t, task, detail), enter?(app, task, cx)}
// ACTIONS  id -> (app, task, cx): what a button with that id does (the inspector's, the card's, a key's)
// MORE     the inspector's More menu: {id, label, kind?: "plain" | "danger", when(task, app) -> bool}; ACTIONS[id] runs it
// DIALOGS  kind -> {title, height?, width?, init?(app, cx, d), body(app, t, d) -> element[],
//           primary?(app, d) -> {label, kind} | null, submit?(app, cx, d) -> Promise | void}
// COMMANDS verb -> (app, arg, cx): a command from the keys, the inbox folder or the palette
// PALETTE  {id, label, hint?, run(app, cx)}: the command palette's entries

export const PAGES = [];
export const TABS = [];
export const ACTIONS = {};
export const MORE = [];
export const DIALOGS = {};
export const COMMANDS = {};
export const PALETTE = [];

/** Adds a page, replacing one with the same id. */
export function page(p) {
  const i = PAGES.findIndex((x) => x.id === p.id);
  if (i >= 0) PAGES[i] = p;
  else PAGES.push(p);
}

/** Adds an inspector tab, replacing one with the same id; tabs show by `order`. */
export function tab(t) {
  const i = TABS.findIndex((x) => x.id === t.id);
  if (i >= 0) TABS[i] = t;
  else TABS.push(t);
  TABS.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export function more(m) {
  const i = MORE.findIndex((x) => x.id === m.id);
  if (i >= 0) MORE[i] = m;
  else MORE.push(m);
}

export function palette(p) {
  const i = PALETTE.findIndex((x) => x.id === p.id);
  if (i >= 0) PALETTE[i] = p;
  else PALETTE.push(p);
}
