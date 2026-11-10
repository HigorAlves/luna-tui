// The six families of environment facts a run can teach, read from its observed calls with no model: a command spelling that fails and
// another that works (form repair), a tool that is not there (absent tool), a host that refuses connections (boundary), a test label shape
// the runner wants (arg repair), a variable value that makes imported code work (env value), a checkout with no remote and no history
// beyond HEAD (empty probe). Ported from TokenEconomizer's env facts (RFC 0007, te-spec 2.2): one run's calls in, candidate evidence out.
// A fact's text is a fixed template filled with a command spelling, a host or a variable name, each checked again here against its own
// strict pattern, so nothing a repository's output wrote ever reaches a prompt. The fold that turns evidence into lifecycle is lifecycle.ts.
//
// Where the container's observation cannot carry what upstream reads:
// - `outcome` is the error class, or "ran" when there is none. `env` (the command was helped by `VAR=value`) is "the observation names a variable".
// - `not_found` (the error line names this very command) is "the error class is command_missing": the observer already chose the
//   segment the error names.
// - An absent tool's `prevented` needs the intent of the fact; a known fact has no intent here, so any build, test or package call stands for it.
// - A known form-repair fact's working forms are read off its text, as the facts keep no counters; the working form a run states is the
//   first that does not move the shell, in call order, so a fact's text is the newest run's, not the most counted.
// - Upstream merges form-repair lines that share a root into one line; the lines here stay one per fact.
// - A call's `ok` is the tool's, and not one whose output the observer read as a failure (a piped test run that exited 0); upstream's `ok` of
//   an environment call also reads the output for a traceback, which the observer does by giving that call a failure fingerprint.
import { createHash } from "node:crypto";

import { findingKinds } from "../../../runner-video/tools/lib/findings.ts";
import type { ObservedCall } from "./observe-run.ts";

export const FAMILIES = ["form_repair", "arg_repair", "env_value", "absent_tool", "empty_probe", "boundary"] as const;
export type Family = (typeof FAMILIES)[number];

/** What one run says about one fact. `text` is the rendered claim, or empty when the run did not state it (a known fact keeps its own). */
export interface Evidence {
  family: Family;
  key: string;
  text: string;
  confirms: boolean;
  contradicts: boolean;
  /** The run used what the fact is about. */
  exercised: boolean;
  /** The fact applied: the failure it names happened, or it was injected and the working way was taken. */
  fired: boolean;
}

export interface KnownFact {
  family: Family;
  key: string;
  text: string;
}

export interface EvidenceContext {
  /** The facts already kept, so a run that only contradicts one is read, and a retired or dropped key is not found again. */
  known?: readonly KnownFact[];
  /** Ids of the facts this run was given. */
  injected?: ReadonlySet<string>;
}

/** Stable across runs and machines: the family and the key. */
export const factId = (family: Family, key: string): string => createHash("sha1").update(`${family}\0${key}`).digest("hex").slice(0, 12);

/** The only text a fact may hold that a repository wrote, each with the pattern that limits it. */
const SPELLING = /^[A-Za-z0-9 ._:=/@+-]{1,120}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}(?::\d{1,5})?$/;
const VAR = /^[A-Z][A-Z0-9_]{2,59}$/;
const VALUE = /^[\w.\-/:]{1,60}$/;
const LABEL = /^[A-Za-z_][\w.\-/]*(?:::[\w.\-[\]]+)*$/;
const PLAIN = /^[A-Za-z0-9_./-]{1,80}$/;
const TOOL = /^[A-Za-z0-9._+-]{1,60}$/;
const MAX_CLAIM = 240;

const FORM_ERRORS: ReadonlySet<string> = new Set(["module_missing", "command_missing", "script_missing", "usage_error", "permission_denied"]);
const NETWORK_ERRORS: ReadonlySet<string> = new Set(["connection_refused", "name_resolution", "unreachable"]);
const ERROR_PHRASE: Record<string, string> = {
  module_missing: "ModuleNotFoundError",
  command_missing: "command not found",
  script_missing: "a file-not-found error",
  usage_error: "a usage error",
  permission_denied: "permission denied",
};
const RUN_WORDS: ReadonlySet<string> = new Set(["run", "npx", "uv", "uvx", "pipx", "poetry", "pipenv", "conda", "-m", "python", "python3"]);
const INTENTS = ["interpreter", "test", "build", "package"] as const;
type Intent = (typeof INTENTS)[number];

// Facts are about forms the person's tools ran, so a form is read as one string.
const isBare = (form: string): boolean => !(form.split(" ")[0] ?? "").includes("/") && !form.includes(" activate ") && !form.includes(" run ") && !/^(?:conda run|poetry run|pipenv run|uv run|npx |uvx )/.test(form);
// The observer's charset has no `&`, so `cd tests && pytest` reaches here as `cd tests pytest`, and `source activate env && pytest` as
// `source activate env pytest`. The prefixes it writes are a fixed few, each one word after its verb, so the `&&` goes back between them.
const PREFIX = /^(cd \S+|source activate \S+|conda activate \S+) (.+)$/;
function shellForm(form: string): string {
  const m = PREFIX.exec(form);
  return m ? `${m[1]} && ${shellForm(m[2] as string)}` : form;
}
const movesShell = (form: string): boolean => form.startsWith("cd ") && PREFIX.test(form);
const toolOf = (form: string): string => {
  const last = form.split(" ").at(-1) ?? "";
  return last.slice(last.lastIndexOf("/") + 1);
};
/** A form as the text writes it: in a subshell when it changes directory, so a persistent shell does not stay there. */
const usage = (form: string, args = " …"): string => (movesShell(form) ? `\`(${shellForm(form)}${args})\`` : `\`${shellForm(form)}${args}\``);
const join = (items: string[]): string => (items.length === 0 ? "the hosts it tried" : items.length === 1 ? (items[0] as string) : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function repairs(form: string, a: string, intent: Intent): boolean {
  if (form === a) return false;
  if (intent === "build") {
    const words = new Set(a.split(" "));
    return form.split(" ").some((w) => words.has(w) && !RUN_WORDS.has(w));
  }
  return intent === "test" ? true : !isBare(form);
}

const failed = (c: ObservedCall): boolean => c.errorClass !== undefined && FORM_ERRORS.has(c.errorClass) && c.labelErr !== true && !(c.intent === "test" && c.errorClass === "usage_error");
const worked = (c: ObservedCall): boolean => c.errorClass === undefined && (c.intent !== "test" || c.testsRan === true);
const helped = (c: ObservedCall): boolean => c.envVar !== undefined || (c.sets !== undefined && Object.keys(c.sets).length > 0);
const typedOk = (c: ObservedCall): boolean => worked(c) && !helped(c);

/** The most counted key; the first inserted wins a tie, as Python's `max` over a dict does. */
function top(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  for (const [k, n] of counts) if (best === undefined || n > (counts.get(best) as number)) best = k;
  return best;
}
const bump = (counts: Map<string, number>, key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
const verdictOf = (confirms: boolean, contradicts: boolean) => ({ confirms: confirms && !contradicts, contradicts });

function formRepair(calls: ObservedCall[], known: readonly KnownFact[], injected: ReadonlySet<string>): { evidence: Evidence[]; repaired: Set<string> } {
  const evidence: Evidence[] = [];
  const repaired = new Set<string>();
  const knownHere = known.filter((k) => k.family === "form_repair");
  for (const intent of INTENTS) {
    const here = calls.filter((c) => c.intent === intent);
    const forms = calls.flatMap((c, i) => (c.intent === intent && c.form !== undefined ? [{ c, i, form: c.form }] : []));
    const okForms = [...new Set(forms.filter((o) => typedOk(o.c)).map((o) => o.form))];
    // Discovery: a failing form, and a later one that worked as typed and is another way to run the same thing.
    const found = new Map<string, Map<string, number>>();
    for (const a of forms) {
      if (!failed(a.c) || ((intent === "interpreter" || intent === "package") && !isBare(a.form))) continue;
      if (!forms.some((o) => o.i > a.i && typedOk(o.c) && repairs(o.form, a.form, intent))) continue;
      const errors = found.get(a.form) ?? new Map<string, number>();
      bump(errors, a.c.errorClass as string);
      found.set(a.form, errors);
    }
    const keys = new Map<string, KnownFact | undefined>([...found.keys()].map((a) => [`${intent}:${a}`, undefined]));
    for (const k of knownHere) if (k.key.startsWith(`${intent}:`)) keys.set(k.key, k);
    for (const [key, old] of keys) {
      const a = key.slice(intent.length + 1);
      const have = okForms.filter((f) => repairs(f, a, intent));
      const b = have.find((f) => !movesShell(f)) ?? have[0];
      let text = "";
      const errors = found.get(a);
      if (errors && b !== undefined && SPELLING.test(a) && SPELLING.test(b)) {
        const e = top(errors) as string;
        text = `${usage(a)} fails here with ${ERROR_PHRASE[e] ?? e}; ${usage(b)} works.`;
      }
      if (old === undefined && text === "") continue;
      if (text !== "" || (old && old.text !== "")) repaired.add(a);
      const workingPart = old?.text.split("; ")[1] ?? "";
      const knownB = (f: string): boolean => workingPart.includes(usage(f));
      const aFailed = forms.some((o) => o.form === a && failed(o.c));
      const bRan = forms.some((o) => worked(o.c) && (knownB(o.form) || (!isBare(o.form) && repairs(o.form, a, intent))));
      const aRunnerOk = (intent === "test" || intent === "build") && forms.some((o) => o.form === a && worked(o.c));
      const exercised = here.length > 0;
      const wasInjected = injected.has(factId("form_repair", key));
      const confirms = aFailed || (bRan && !aRunnerOk);
      const contradicts = !confirms && aRunnerOk;
      if (!exercised && !confirms && !contradicts) continue;
      evidence.push({ family: "form_repair", key, text, ...verdictOf(confirms, contradicts), exercised, fired: aFailed || (wasInjected && bRan && !aFailed) });
    }
  }
  return { evidence, repaired };
}

const labelOf = (c: ObservedCall): string[] => (c.labels ?? []).filter((l) => LABEL.test(l) && l.length <= 120);
const loaded = (c: ObservedCall): boolean => labelOf(c).length > 0 && c.labelErr !== true && c.testsRan === true;

/** `("sep", "::")` when `b` is `a` written with dots; `("strip", prefix)` when `b` is `a` without its first component. */
function labelRule(a: string, b: string): { kind: "sep" | "strip"; param: string } | undefined {
  const nearly = (x: string, y: string): boolean => x === y || x.startsWith(`${y}.`) || x.startsWith(`${y}/`) || y.startsWith(`${x}.`) || y.startsWith(`${x}/`);
  if (a.includes("::") && !b.includes("::") && nearly(a.replaceAll("::", "."), b)) return { kind: "sep", param: "::" };
  const m = /^[^./]*[./]/.exec(a);
  if (m && nearly(a.slice(m[0].length), b) && !b.startsWith(m[0])) return { kind: "strip", param: m[0] };
  return undefined;
}

function argRepair(calls: ObservedCall[], known: readonly KnownFact[], injected: ReadonlySet<string>): Evidence[] {
  const runs = calls.filter((c) => c.intent === "test" && c.form !== undefined && labelOf(c).length > 0);
  const found = new Map<string, { form: string; kind: "sep" | "strip"; param: string; examples: Map<string, number> }>();
  runs.forEach((A, ai) => {
    if (A.labelErr !== true) return;
    for (const a of labelOf(A)) {
      for (const B of runs.slice(ai + 1)) {
        if (B.form !== A.form || !loaded(B)) continue;
        const hit = labelOf(B).map((b) => ({ b, rule: labelRule(a, b) })).find((x) => x.rule);
        if (!hit?.rule) continue;
        const key = `${A.form}:${hit.rule.kind}:${hit.rule.param}`;
        const entry = found.get(key) ?? { form: A.form as string, ...hit.rule, examples: new Map<string, number>() };
        bump(entry.examples, `${a} ${hit.b}`);
        found.set(key, entry);
        break;
      }
    }
  });
  const keys = new Map<string, { form: string; kind: "sep" | "strip"; param: string } | undefined>([...found].map(([k, v]) => [k, v]));
  for (const k of known) {
    const m = k.family === "arg_repair" ? /^(.*):(sep|strip):(.+)$/.exec(k.key) : null;
    if (m) keys.set(k.key, { form: m[1] as string, kind: m[2] as "sep" | "strip", param: m[3] as string });
  }
  const out: Evidence[] = [];
  for (const [key, fact] of keys) {
    if (!fact) continue;
    const mine = runs.filter((c) => c.form === fact.form);
    const bad = (l: string): boolean => (fact.kind === "sep" ? l.includes("::") : l.startsWith(fact.param));
    const badFailed = mine.some((c) => c.labelErr === true && labelOf(c).some(bad));
    const badLoaded = mine.some((c) => loaded(c) && labelOf(c).some(bad));
    const goodLoaded = mine.some((c) => loaded(c) && labelOf(c).some((l) => !bad(l)));
    let text = "";
    const entry = found.get(key);
    if (entry && SPELLING.test(entry.form)) {
      if (entry.kind === "sep") text = `${usage(entry.form, "")} takes dotted test labels (\`module.Class.test\`, not \`module::Class::test\`).`;
      else {
        const [a, b] = [...entry.examples.keys()].map((e) => e.split(" ") as [string, string]).sort((x, y) => x[0].length - y[0].length)[0] as [string, string];
        if (PLAIN.test(entry.param) && PLAIN.test(a) && PLAIN.test(b)) text = `${usage(entry.form, "")} takes test labels without the \`${entry.param}\` prefix (\`${b}\`, not \`${a}\`).`;
      }
    }
    const isNew = !known.some((k) => k.family === "arg_repair" && k.key === key);
    if (isNew && text === "") continue;
    const confirms = badFailed || goodLoaded;
    const contradicts = badLoaded;
    const exercised = mine.length > 0;
    if (!exercised && !confirms && !contradicts) continue;
    out.push({ family: "arg_repair", key, text, ...verdictOf(confirms, contradicts), exercised, fired: badFailed || (injected.has(factId("arg_repair", key)) && goodLoaded && !badFailed) });
  }
  return out;
}

function envValue(calls: ObservedCall[], known: readonly KnownFact[], injected: ReadonlySet<string>): Evidence[] {
  const found = new Map<string, { good: Map<string, number>; bad: Map<string, number> }>();
  calls.forEach((c, i) => {
    for (const v of c.needs ?? []) {
      if (!VAR.test(v)) continue;
      const later = calls.slice(i + 1).filter((l) => l.sets !== undefined && Object.hasOwn(l.sets, v));
      const good = later.filter((l) => l.ok && !l.needs?.includes(v)).map((l) => (l.sets as Record<string, string>)[v] as string).filter((x) => VALUE.test(x));
      if (good.length === 0) continue;
      const entry = found.get(v) ?? { good: new Map<string, number>(), bad: new Map<string, number>() };
      bump(entry.good, good[0] as string);
      for (const l of later) {
        const value = (l.sets as Record<string, string>)[v] as string;
        if (!l.ok && value !== good[0] && VALUE.test(value)) bump(entry.bad, value);
      }
      found.set(v, entry);
    }
  });
  const keys = new Set<string>(found.keys());
  for (const k of known) if (k.family === "env_value" && VAR.test(k.key)) keys.add(k.key);
  const out: Evidence[] = [];
  for (const v of keys) {
    const entry = found.get(v);
    const old = known.find((k) => k.family === "env_value" && k.key === v);
    const good = entry ? top(entry.good) : new RegExp(`\`${v}=([\\w.\\-/:]+)\` works`).exec(old?.text ?? "")?.[1];
    if (good === undefined) continue;
    const sets = calls.filter((c) => c.sets !== undefined && Object.hasOwn(c.sets, v));
    const asked = calls.some((c) => c.needs?.includes(v));
    const goodOk = sets.some((c) => c.sets?.[v] === good && c.ok);
    const goodFailed = sets.some((c) => c.sets?.[v] === good && c.needs?.includes(v));
    let text = "";
    if (entry) {
      const bad = [...entry.bad.keys()].sort().find((x) => x !== good);
      text = `Code that imports the project needs \`${v}\` set here: \`${v}=${good}\` works${bad === undefined ? "." : `, \`${bad}\` does not.`}`;
    }
    const exercised = asked || sets.length > 0;
    const confirms = goodOk;
    const contradicts = goodFailed;
    if (!exercised && !confirms && !contradicts) continue;
    out.push({ family: "env_value", key: v, text, ...verdictOf(confirms, contradicts), exercised, fired: asked || (injected.has(factId("env_value", v)) && goodOk) });
  }
  return out;
}

const BUILD_LIKE: ReadonlySet<string> = new Set(["build", "test", "package"]);

function absentTool(calls: ObservedCall[], known: readonly KnownFact[], injected: ReadonlySet<string>, repaired: ReadonlySet<string>): Evidence[] {
  const ranTools = new Set(calls.flatMap((c) => (c.form !== undefined && worked(c) ? [toolOf(c.form)] : [])));
  const missing = (c: ObservedCall): boolean => c.intent !== undefined && BUILD_LIKE.has(c.intent) && c.errorClass === "command_missing" && c.form !== undefined && !c.form.includes(" ");
  const found = new Set(calls.flatMap((c) => (missing(c) && !repaired.has(c.form as string) && !ranTools.has(c.form as string) && TOOL.test(c.form as string) ? [c.form as string] : [])));
  const keys = new Set(found);
  for (const k of known) if (k.family === "absent_tool") keys.add(k.key);
  const sawBuildLike = calls.some((c) => c.intent !== undefined && BUILD_LIKE.has(c.intent));
  const out: Evidence[] = [];
  for (const tool of keys) {
    const seen = calls.filter((c) => c.form !== undefined && toolOf(c.form) === tool);
    const contradicted = repaired.has(tool) || seen.some(worked);
    const missingNow = seen.some((c) => c.form === tool && c.errorClass === "command_missing");
    const prevented = injected.has(factId("absent_tool", tool)) && !contradicted && sawBuildLike;
    const fired = missingNow || prevented;
    const exercised = fired || contradicted;
    if (!exercised) continue;
    const text = missingNow && found.has(tool) ? `\`${tool} …\` fails here with command not found, and no other way to run it has worked.` : "";
    out.push({ family: "absent_tool", key: tool, text, ...verdictOf(fired, contradicted), exercised, fired });
  }
  return out;
}

function emptyProbe(calls: ObservedCall[]): Evidence[] {
  const probes = calls.filter((c) => c.probe !== undefined);
  if (probes.length === 0) return [];
  const contradicts = probes.some((c) => c.probe === "hit");
  const text = "This checkout has no git remote and no branches, tags or unreachable objects beyond HEAD; its history ends at the checked-out commit.";
  return [{ family: "empty_probe", key: "vcs_refs", text, ...verdictOf(true, contradicts), exercised: true, fired: true }];
}

function boundary(calls: ObservedCall[], known: readonly KnownFact[]): Evidence[] {
  const fetches = calls.filter((c) => c.intent === "fetch" && c.host !== undefined && HOST.test(c.host));
  const refused = fetches.filter((c) => c.errorClass !== undefined && NETWORK_ERRORS.has(c.errorClass));
  const old = known.find((k) => k.family === "boundary");
  if (refused.length === 0 && !old) return [];
  const counts = new Map<string, number>();
  for (const c of refused) bump(counts, c.host as string);
  const hosts = new Set([...counts.keys(), ...(old?.text.split(/[\s,]+/) ?? [])]);
  const contradicts = fetches.some((c) => c.errorClass === undefined && c.ok && hosts.has(c.host as string));
  const exercised = fetches.length > 0;
  if (!exercised) return [];
  const topHosts = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([h]) => h);
  const text = refused.length > 0 ? `Outbound connections to ${join(topHosts)} are refused here; nothing can be fetched from them.` : "";
  return [{ family: "boundary", key: "fetch_remote", text, ...verdictOf(refused.length > 0, contradicts), exercised, fired: refused.length > 0 }];
}

/** What one run's calls say about the six families, for the facts kept so far and for new ones. A candidate whose text fails a pattern is dropped. */
export function evidenceOf(calls: ObservedCall[], context: EvidenceContext = {}): Evidence[] {
  const known = context.known ?? [];
  const injected = context.injected ?? new Set<string>();
  const forms = formRepair(calls, known, injected);
  const all = [
    ...forms.evidence,
    ...argRepair(calls, known, injected),
    ...envValue(calls, known, injected),
    ...absentTool(calls, known, injected, forms.repaired),
    ...emptyProbe(calls),
    ...boundary(calls, known),
  ];
  return all.flatMap((e) => {
    if (e.text === "") return [e];
    if (e.text.length <= MAX_CLAIM && !e.text.includes("\n") && findingKinds(e.text).length === 0) return [e];
    // A text that must not be shown is never kept; a fact the machine already holds still hears what this run says of it.
    return known.some((k) => k.family === e.family && k.key === e.key) ? [{ ...e, text: "" }] : [];
  });
}
