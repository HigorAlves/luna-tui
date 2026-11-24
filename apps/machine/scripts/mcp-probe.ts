// One-off: connect to an MCP server over streamable HTTP as the machine would, and print its tools.
// Usage: tsx scripts/mcp-probe.ts <url> [bearer-token]. RFC 0013, phase 1, open item one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token] = process.argv.slice(2);
if (!url) {
  console.error("usage: mcp-probe <url> [token]");
  process.exit(2);
}
const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
const client = new Client({ name: "luna-machine", version: "0.0.0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name);
  await client.close();
} catch (error) {
  console.error(String((error as Error).message ?? error));
  process.exit(1);
}
