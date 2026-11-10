// Rust keeps unit tests in the file they test, in a `#[cfg(test)] mod tests { ... }` block. The tests step takes a change to a `.rs` source file
// as a test change only inside such a block, so it needs to know where the blocks are. Pure.

/** The source with comments, strings and char literals blanked (newlines kept), so braces and attributes in them are never read as code. */
export function maskRust(source: string): string {
  const out: string[] = [];
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(source[k] === "\n" ? "\n" : " ");
  };
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") (depth++, (j += 2));
        else if (source[j] === "*" && source[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      blank(i, j);
      i = j;
    } else if ((c === "r" || (c === "b" && next === "r")) && !/[A-Za-z0-9_]/.test(source[i - 1] ?? " ")) {
      // A raw string: r"..", r#".."#, br#".."#.
      let j = i + (c === "b" ? 2 : 1);
      let hashes = 0;
      while (source[j] === "#") (hashes++, j++);
      if (source[j] === '"') {
        const close = `"${"#".repeat(hashes)}`;
        const end = source.indexOf(close, j + 1);
        const stop = end === -1 ? n : end + close.length;
        blank(i, stop);
        i = stop;
      } else {
        out.push(c);
        i++;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      const stop = Math.min(n, j + 1);
      blank(i, stop);
      i = stop;
    } else if (c === "'") {
      // A char literal ('a', '\n', '\u{1f600}'), not a lifetime ('a, 'static).
      const m = /^'(?:\\[^']*|[^\\'])'/.exec(source.slice(i, i + 14));
      if (m) {
        blank(i, i + m[0].length);
        i += m[0].length;
      } else {
        out.push(c);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

const TEST_MOD = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/g;

/** The 1-based, inclusive line ranges of each `#[cfg(test)] mod name { ... }` block, from its attribute to its closing brace. A block whose braces do not balance is not one. */
export function rustTestRegions(source: string): Array<[number, number]> {
  const masked = maskRust(source);
  const lineOf = (index: number): number => {
    let line = 1;
    for (let k = 0; k < index; k++) if (masked[k] === "\n") line++;
    return line;
  };
  const regions: Array<[number, number]> = [];
  for (const match of masked.matchAll(TEST_MOD)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < masked.length; k++) {
      if (masked[k] === "{") depth++;
      else if (masked[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    if (close !== -1) regions.push([lineOf(match.index), lineOf(close)]);
  }
  return regions;
}
