import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "probe", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.argv[2]), { requestInit: { headers: { Authorization: `Bearer ${process.env.MMF_TOKEN}` } } }));
const [, , , tool, json] = process.argv;
const t0 = Date.now();
const r = await c.callTool({ name: tool, arguments: JSON.parse(json) });
console.log(Date.now() - t0, "ms", JSON.stringify(r).slice(0, 1500));
await c.close();
