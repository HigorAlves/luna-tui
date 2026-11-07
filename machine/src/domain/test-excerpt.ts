// What the red_check judge reads of a scenario's test: the test's own source, cut around its tag. The test is the writer's text, so it
// reaches the judge as data (core/decide.ts quotes the whole check). Pure.
export const EXCERPT_LINES = 80;
export const EXCERPT_CHARS = 4000;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The lines of `source` from the one tagged `@scenario:<id>` (the tag on its own, never `S1` inside `S10`) down to the next tag, at most 80 lines and 4,000 characters; the head of the file when nothing carries the tag. */
export function testExcerpt(source: string, id: string): string {
  const lines = source.split("\n");
  const tag = new RegExp(`@scenario:${escape(id)}(?![A-Za-z0-9_-])`);
  const anyTag = /@scenario:/;
  const at = lines.findIndex((line) => tag.test(line));
  if (at === -1) return source.slice(0, EXCERPT_CHARS);
  let end = Math.min(lines.length, at + EXCERPT_LINES);
  for (let i = at + 1; i < end; i++) {
    // The next scenario's tag ends this one, but a tag in a comment above its test is one line early: keep the lines up to it.
    if (anyTag.test(lines[i]!) && !tag.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n").slice(0, EXCERPT_CHARS);
}
