import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Discovery only: no wallet, tool calls, payment payloads, or capabilities.
const client = new Client({ name: "task402-discovery-example", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("https://task402.xyz/mcp")) as unknown as Parameters<typeof client.connect>[0]);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor);
  console.log(JSON.stringify({ endpoint: "https://task402.xyz/mcp", toolCount: names.length, tools: names }, null, 2));
} finally {
  await client.close();
}
