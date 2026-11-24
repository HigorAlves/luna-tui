// Which bridged MCP tools a stage gets: what the pack names, kept only where the machine declares
// the server and tool, and narrowed by the repo's luna.yaml. An untrusted card gets none unless the
// machine's mcp.yaml says `untrusted: allow` (RFC 0013, Trust). Pure.
import type { BridgeGrant, McpServerConfig } from "@hardness/contracts";

export type RepoNarrowing = Record<string, { tools?: string[] }>;

export function grantedTools(
  pack: readonly BridgeGrant[],
  servers: readonly McpServerConfig[],
  repo: RepoNarrowing,
  trust: "trusted" | "untrusted",
  machine: { untrusted: "allow" | "deny" },
): { grants: BridgeGrant[]; notes: string[] } {
  if (trust === "untrusted" && machine.untrusted === "deny") return { grants: [], notes: pack.length ? ["untrusted card: no bridged tools"] : [] };
  const notes: string[] = [];
  const grants: BridgeGrant[] = [];
  for (const g of pack) {
    const server = servers.find((s) => s.name === g.server);
    if (!server) {
      notes.push(`${g.server}: no such server on this machine`);
      continue;
    }
    const narrowed = repo[g.server]?.tools;
    const tools = g.tools.filter((t) => {
      if (!server.tools.includes(t)) {
        notes.push(`${g.server}: ${t} is not bridged by the machine`);
        return false;
      }
      return !narrowed || narrowed.includes(t);
    });
    if (tools.length) grants.push({ server: g.server, tools });
  }
  return { grants, notes };
}
