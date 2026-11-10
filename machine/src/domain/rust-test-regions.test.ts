import { describe, expect, it } from "vitest";

import { maskRust, rustTestRegions } from "./rust-test-regions.ts";

const lines = (...l: string[]) => l.join("\n");

describe("rustTestRegions", () => {
  it("finds a test module from its attribute to its closing brace", () => {
    const src = lines("fn a() {}", "", "#[cfg(test)]", "mod tests {", "    use super::*;", "    #[test]", "    fn t() { assert!(true); }", "}", "fn after() {}");
    expect(rustTestRegions(src)).toEqual([[3, 8]]);
  });
  it("is not fooled by braces in strings, chars, comments and raw strings", () => {
    const src = lines("#[cfg(test)]", "mod tests {", '    const A: &str = "}}}";', "    const B: char = '}';", "    // } }", '    const C: &str = r#"}"#;', "    /* { /* } */ */", "    fn t<'a>(x: &'a str) {}", "}", "fn after() {}");
    expect(rustTestRegions(src)).toEqual([[1, 9]]);
  });
  it("reads other attributes between cfg(test) and mod, and pub mod", () => {
    expect(rustTestRegions(lines("#[cfg(test)]", "#[allow(dead_code)]", "pub(crate) mod tests {", "}"))).toEqual([[1, 4]]);
  });
  it("ignores a cfg(test) that is in a comment or a string, a cfg(not(test)) and an unbalanced block", () => {
    expect(rustTestRegions(lines("// #[cfg(test)]", "// mod tests {", "}"))).toEqual([]);
    expect(rustTestRegions(lines('const S: &str = "#[cfg(test)] mod tests {";', "}"))).toEqual([]);
    expect(rustTestRegions(lines("#[cfg(not(test))]", "mod real {", "}"))).toEqual([]);
    expect(rustTestRegions(lines("#[cfg(test)]", "mod tests {", "fn t() {"))).toEqual([]);
  });
  it("finds two modules", () => {
    expect(rustTestRegions(lines("#[cfg(test)]", "mod a {", "}", "fn x() {}", "#[cfg(test)]", "mod b {", "}"))).toEqual([[1, 3], [5, 7]]);
  });
  it("masks without moving a line", () => {
    const src = lines('let a = "x', 'y";', "// c", "/* a", "b */ let z = 1;");
    expect(maskRust(src).split("\n")).toHaveLength(src.split("\n").length);
  });
});
