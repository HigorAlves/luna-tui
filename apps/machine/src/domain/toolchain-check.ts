// `toolchains` in luna.yaml (`node: "24"`) checked against the repository's image: the image probe runs each known tool's version command
// and the major (and the minor when given) is compared. A mismatch is a warning on the repo's health; it never blocks a run. The probe is
// a script of fixed commands: the repository's text picks which of them run (by a known name), and is never part of the script.

const TOOLS: Record<string, { name: string; command: string }> = {
  node: { name: "node", command: "node --version" },
  python: { name: "python", command: "python3 --version || python --version" },
  go: { name: "go", command: "go version" },
  rust: { name: "rust", command: "rustc --version" },
  cargo: { name: "rust", command: "rustc --version" },
  java: { name: "java", command: "java -version" },
  ruby: { name: "ruby", command: "ruby --version" },
  pnpm: { name: "pnpm", command: "pnpm --version" },
};

const PREFIX = "luna-tool:";

/** The shell lines for the known tools among `toolchains`, one `luna-tool:<name>=<first line>` each; empty when none is known. */
export function toolchainProbe(toolchains: Record<string, string>): string {
  const names = [...new Set(Object.keys(toolchains).map((key) => TOOLS[key.toLowerCase()]).filter((t) => t !== undefined).map((t) => t!.name))];
  const commands = new Map(Object.values(TOOLS).map((t) => [t.name, t.command]));
  return names.map((name) => `printf '${PREFIX}${name}=%s\\n' "$( (${commands.get(name)!}) 2>&1 | head -n 1)"`).join("; ");
}

/** `[major, minor]` of what a tool printed, or null when it printed no version (the tool is not there). */
export function versionOf(tool: string, text: string): [number, number] | null {
  const found = /(\d+)(?:\.(\d+))?/.exec(text);
  if (!found || /not found|no such file/i.test(text)) return null;
  let major = Number(found[1]);
  let minor = Number(found[2] ?? 0);
  // Java 8 calls itself 1.8.
  if (tool === "java" && major === 1 && found[2] !== undefined) {
    major = minor;
    minor = Number(/\d+\.\d+\.(\d+)/.exec(text)?.[1] ?? 0);
  }
  return [major, minor];
}

/** One warning per `toolchains` entry the image does not satisfy; `probeOutput` is what the probe script printed. */
export function toolchainWarnings(toolchains: Record<string, string>, probeOutput: string): string[] {
  const printed = new Map<string, string>();
  for (const line of probeOutput.split("\n")) {
    if (!line.startsWith(PREFIX)) continue;
    const eq = line.indexOf("=");
    printed.set(line.slice(PREFIX.length, eq), line.slice(eq + 1));
  }
  const warnings: string[] = [];
  for (const [key, wanted] of Object.entries(toolchains)) {
    const tool = TOOLS[key.toLowerCase()];
    if (!tool) continue;
    const want = /(\d+)(?:\.(\d+))?/.exec(wanted);
    if (!want) continue;
    const wantedText = wanted.length > 40 ? `${wanted.slice(0, 40)}...` : wanted;
    const have = versionOf(tool.name, printed.get(tool.name) ?? "");
    if (!have) {
      warnings.push(`toolchains ${key}: the image has none, luna.yaml wants ${wantedText}`);
      continue;
    }
    const major = Number(want[1]);
    const minor = want[2] === undefined ? null : Number(want[2]);
    if (have[0] !== major || (minor !== null && have[1] !== minor)) warnings.push(`toolchains ${key}: the image has ${have[0]}.${have[1]}, luna.yaml wants ${wantedText}`);
  }
  return warnings;
}
