// The sidebar lists the pages by category, folds a category on a click and keeps the page you are on.
import assert from "node:assert/strict";
import { test } from "node:test";

import { theme } from "./host/stub.js";
import "../luna/features.js";
import { PAGES } from "../luna/registry.js";
import { NAV_GROUPS, navGroups, sidebar } from "../luna/board.js";

const t = theme();

const texts = (el, out = []) => {
  out.push(...(el.words ?? []));
  for (const c of el.kids ?? []) texts(c, out);
  return out;
};

function app(over = {}) {
  return {
    machine: { base: "http://127.0.0.1:4318" }, tasks: [], prs: { inbox: null, all: null }, page: "board", view: "all", project: null,
    link: "live", search: {}, searchFocused: false, busy: new Set(), state(id) { this.s ??= {}; return (this.s[id] ??= {}); },
    go() {}, reload() {}, newTask() {}, ...over,
  };
}

test("every visible page sits under a known category, in the categories' order", () => {
  const groups = navGroups(PAGES);
  assert.deepEqual(groups.map((g) => g.id), NAV_GROUPS.map((g) => g.id));
  assert.deepEqual(groups.find((g) => g.id === "work").pages.map((p) => p.id), ["board", "prs", "inbox", "digest"]);
  assert.deepEqual(groups.find((g) => g.id === "plan").pages.map((p) => p.id), ["backlog", "tickets"]);
  assert.deepEqual(groups.find((g) => g.id === "sources").pages.map((p) => p.id), ["slack", "jira"]);
  assert.deepEqual(groups.find((g) => g.id === "factory").pages.map((p) => p.id), ["floor", "economy"]);
  assert.ok(!groups.flatMap((g) => g.pages).some((p) => p.hidden), "hidden pages stay out");
});

test("a page with no known category goes under Other", () => {
  const groups = navGroups([{ id: "a", group: "work" }, { id: "b", group: "nope" }, { id: "c" }]);
  assert.deepEqual(groups.map((g) => [g.id, g.pages.map((p) => p.id)]), [["work", ["a"]], ["other", ["b", "c"]]]);
});

test("the sidebar draws the category headings; a folded one keeps only the page you are on", () => {
  const open = texts(sidebar(app(), t));
  for (const g of NAV_GROUPS) assert.ok(open.includes(g.label), g.label);
  assert.ok(open.includes("Slack") && open.includes("Jira"));
  const shut = texts(sidebar(app({ page: "jira", navFold: new Set(["sources"]) }), t));
  assert.ok(shut.includes("Jira"), "the page you are on stays");
  assert.ok(!shut.includes("Slack"), "the rest of the folded category goes");
});
