// `make luna-yaml`'s answers applied to a repo's luna.yaml (scripts/setup/luna-yaml.sh asks, this
// writes). Answers are `path=value` lines (`jira.on.closed=Done`); an empty value removes the key,
// so a section can be replaced whole. An existing file is edited in place through yaml's document
// model, its comments and the sections nobody asked about kept; a new one is rendered like setup's.
// Either way the result is validated as the machine reads it, so the wizard never writes a file
// the machine would refuse. Pure: no disk.
import { type EngineId, type LunaConfig, PACKS, type PackId } from "@hardness/contracts";
import { Document, isMap, parse as parseYaml, parseDocument } from "yaml";

import { parseLunaConfig, renderLunaConfig, validateLunaConfig } from "./luna-config.ts";
import { packStates } from "./packs.ts";
import { PolicyParseError } from "./policy.ts";

export interface Answer {
  path: string[];
  /** Empty removes the key. */
  value: string;
}

export interface Applied {
  text: string;
  config: LunaConfig;
  /** What the machine would drop from the file with a warning (a state `jira.on` cannot map). */
  warnings: string[];
}

/** The answers file: one `path=value` per line; blank lines and `#` comments are skipped. */
export function parseAnswers(text: string): Answer[] {
  const answers: Answer[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    const at = line.indexOf("=");
    const path = at < 0 ? [] : line.slice(0, at).trim().split(".").filter(Boolean);
    if (path.length === 0) throw new PolicyParseError(`answers line ${i + 1}: expected path=value`);
    answers.push({ path, value: line.slice(at + 1) });
  });
  return answers;
}

/** Numbers and booleans where the file takes them (policy, budget); text everywhere else, so a Jira project or status that looks like a number stays one. */
function valueOf(path: string[], value: string): string | number | boolean {
  if (path[0] !== "policy" && path[0] !== "budget") return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}

/** The repo's file (null when it has none) with the answers applied, validated as the machine reads it. */
export function applyAnswers(existing: string | null, answers: Answer[]): Applied {
  const text = existing === null || existing.trim() === "" ? fresh(answers) : edited(existing, answers);
  const warnings: string[] = [];
  parseLunaConfig(text, (message) => warnings.push(message));
  const raw: unknown = parseYaml(text);
  return { text, config: validateLunaConfig(raw ?? {}), warnings };
}

function fresh(answers: Answer[]): string {
  const doc = new Document({});
  for (const { path, value } of answers) if (value !== "") doc.setIn(path, valueOf(path, value));
  return renderLunaConfig(validateLunaConfig(doc.toJS()));
}

function edited(existing: string, answers: Answer[]): string {
  const doc = parseDocument(existing);
  if (doc.errors.length > 0) throw new PolicyParseError(`not valid YAML: ${doc.errors[0]!.message}`);
  for (const { path, value } of answers) {
    if (value === "") {
      // yaml throws deleting under a section the file lacks; there is nothing to remove then.
      if (doc.getIn(path, true) === undefined) continue;
      doc.deleteIn(path);
      // A section left empty goes too, rather than staying as `policy: {}`.
      for (let i = path.length - 1; i > 0; i--) {
        const parent = doc.getIn(path.slice(0, i), true);
        if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, i));
      }
    } else {
      doc.setIn(path, valueOf(path, value));
    }
  }
  return doc.toString({ lineWidth: 0 });
}

/** Every scalar of the file as `path=value`, in file order: the wizard's defaults. */
export function flattenLunaConfig(text: string | null): string[] {
  const lines: string[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    } else if (value !== null && value !== undefined && path.length > 0) {
      lines.push(`${path.join(".")}=${String(value).replaceAll("\n", " ")}`);
    }
  };
  if (text !== null) walk(parseYaml(text), []);
  return lines;
}

export interface ChoosableEngines {
  pack: PackId;
  default: EngineId;
  /** The default first, then the other engines the pack allows. */
  engines: EngineId[];
}

/** The packs a task runs whose engine a repo can choose: those that allow more than one. */
export function choosableEngines(): ChoosableEngines[] {
  return (Object.keys(PACKS) as PackId[])
    .filter((id) => packStates(id).length > 0 && PACKS[id].engines.allowed.length > 1)
    .map((id) => {
      const { default: def, allowed } = PACKS[id].engines;
      return { pack: id, default: def, engines: [def, ...allowed.filter((e) => e !== def)] };
    });
}
