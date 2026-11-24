export interface KnownScenario {
  id: string;
  text: string;
  result: string;
}

/** The scenarios a fix may have changed: those the reader named that are approved ones, and those whose tagged test file the fix changed. Unknown ids are dropped. Pure. */
export function affectedScenarios(input: { named: string[]; changed: string[]; tests: Array<{ scenario: string; file?: string | null }>; known: KnownScenario[] }): KnownScenario[] {
  const changed = new Set(input.changed);
  const ids = new Set(input.named);
  for (const t of input.tests) if (t.file && changed.has(t.file)) ids.add(t.scenario);
  return input.known.filter((s) => ids.has(s.id));
}
