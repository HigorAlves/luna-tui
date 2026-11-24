// What a change to some files reaches, read from the code graph: who imports them, who sits one hop
// further, and the tests that go with them by the usual naming. Pure.
import { type GraphJson, blastRadius } from "./blast-radius.ts";

export interface Impact {
  /** Files that import or call the changed ones directly. */
  importers: string[];
  /** Files two hops from them, not already importers. */
  dependents: string[];
  /** Test files of the changed files and of the files that reach them, by naming convention. */
  tests: string[];
}

const MAX_TESTS = 40;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+$/i;
/** `FooTest.java`, `FooTests.cs`: a capital T after the name, so `latest.ts` is not one. */
const CAMEL_TEST = /[a-z0-9]Tests?\.[a-z0-9]+$/;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path) || CAMEL_TEST.test(path);

/** `src/cart/coupon.ts` -> `coupon`; `coupon.test.ts`, `test_coupon.py`, `coupon_test.go`, `CouponTest.java` -> `coupon`. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[._-](test|spec)$/i, "")
    .replace(/^test_/i, "")
    .replace(/Tests?$/, "")
    .toLowerCase();
}

export function impact(graph: GraphJson, files: string[]): Impact {
  const importers = blastRadius(graph, files, 1);
  const two = blastRadius(graph, files, 2);
  const dependents = two.filter((f) => !importers.includes(f));
  const known = new Set<string>();
  for (const node of graph.nodes ?? []) if (node.source_file) known.add(node.source_file.replace(/^(\.\/|\/work\/)/, ""));
  const stems = new Set([...files, ...importers].filter((f) => !isTestFile(f)).map(stemOf).filter((s) => s.length >= 3));
  const tests = new Set<string>([...importers, ...dependents].filter(isTestFile));
  for (const file of known) if (isTestFile(file) && stems.has(stemOf(file))) tests.add(file);
  return { importers, dependents, tests: [...tests].sort().slice(0, MAX_TESTS) };
}
