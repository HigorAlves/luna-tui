// What a failing tool output is, without keeping its text: whether it carries an error marker, the
// first line that does (as a hash with numbers, hex and paths removed, so two runs that fail the
// same way agree), and the environment error class it falls into. Ported from TokenEconomizer's
// loop guard and micro-skill observer (RFC 0007); the hash is sha256 rather than md5, since it is
// only ever compared with itself.
import { createHash } from "node:crypto";

// Python's `(?-i:...)` has no counterpart in this engine, so the Go branch, which is case-sensitive,
// is a second pattern ORed in by `isErrorLine`.
const ERR_CI =
  /Traceback \(most recent call last\)|\b\w*Error\b|\bFAILED\b|\bassert\b|Exception|errors during collection|^# fail [1-9]|^not ok \d|\b[1-9]\d* (?:failing|failures?)\b|Failures: [1-9]/im;
const ERR_GO = /^(?:--- FAIL: |FAIL\t|FAIL$)/m;

/** Whether a text, or one line of it, carries a failure marker of any common runner or language. */
export function isErrorOutput(text: string): boolean {
  return ERR_CI.test(text) || ERR_GO.test(text);
}

/** Python's `str.splitlines()`: breaks on \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85 and the Unicode separators, with no empty last line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The hash of the first line that matches the error markers (or `also`), with `0x…`, digit runs and `/path` words deleted; undefined when no line matches. */
export function failureSignature(text: string, also?: RegExp): string | undefined {
  if (!text) return undefined;
  const line = splitLines(text).find((l) => isErrorOutput(l) || (also !== undefined && also.test(l)));
  if (line === undefined) return undefined;
  const norm = line.replace(/0x[0-9a-f]+|\d+|\/\S+/g, "").trim();
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 10);
}

/** Errors an environment produces, as opposed to the code under test. The first match in this order names the class. */
const ERROR_CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["module_missing", /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i],
  ["command_missing", /command not found|: not found\b|is not recognized/i],
  ["script_missing", /can't open file .*No such file or directory/i],
  ["permission_denied", /Permission denied|EACCES/i],
  ["usage_error", /^usage:|unrecognized arguments|no such option|error: argument|unknown option/im],
  ["connection_refused", /Connection refused|Failed to connect to|couldn't connect to|Could not connect|ECONNREFUSED/i],
  ["name_resolution", /Could not resolve host|Temporary failure in name resolution|Name or service not known|getaddrinfo|nodename nor servname|ENOTFOUND/i],
  ["unreachable", /Network is unreachable|No route to host|Connection timed out|Operation timed out|timed out after|ETIMEDOUT/i],
];

export const NETWORK_ERRORS: ReadonlySet<string> = new Set(["connection_refused", "name_resolution", "unreachable"]);

export interface ErrorClassHit {
  name: string;
  /** The pattern that matched, so a caller can find the line it hit. */
  pattern: RegExp;
  /** The output line that matched, when one line did. */
  line?: string;
}

/** The environment error class of an output, or undefined. */
export function errorClassOf(output: string): ErrorClassHit | undefined {
  for (const [name, pattern] of ERROR_CLASSES) {
    if (!pattern.test(output)) continue;
    return { name, pattern, line: splitLines(output).find((l) => pattern.test(l)) };
  }
  return undefined;
}
