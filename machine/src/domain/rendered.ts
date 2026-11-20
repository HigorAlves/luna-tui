// Which changed files a browser renders (RFC 0013): the QA stage runs only for a change that touches one, and the ui-designer may take only a slice whose files all do.

/** A file the browser renders, or the folder such files live in; `package.json` because a
 *  dependency bump changes what renders too. */
const RENDERED_EXT = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|mdx|j2|hbs|ejs|svg|png|jpe?g|gif|webp|woff2?)$/i;
const RENDERED_DIRS = new Set(["app", "pages", "components", "public", "static", "views", "templates", "ui", "assets", "styles"]);

/** True when any changed path is something on screen could depend on. */
export function touchesRenderedSurface(files: string[], webRootDirs: string[] = []): boolean {
  return files.some((file) => {
    const parts = file.split("/");
    const name = parts.at(-1) ?? "";
    if (name === "package.json" || RENDERED_EXT.test(name) || parts.slice(0, -1).some((dir) => RENDERED_DIRS.has(dir))) return true;
    // Inside a web package, any source under src/ may render the page (a .ts that builds the
    // DOM looks like any other .ts); only tests are known not to.
    if (TEST_PATH.test(file)) return false;
    return webRootDirs.some((root) => file.startsWith(root === "" ? "src/" : `${root}/src/`));
  });
}
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$/i;
