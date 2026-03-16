const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const MCP_URL = process.env.MCP_SERVER_URL || "http://localhost:4000/mcp";

let client = null;
let transport = null;
let toolCache = null;

async function connect() {
  // Clean up any previous connection
  if (transport) {
    try { await transport.close(); } catch {}
  }
  client = null;
  transport = null;
  toolCache = null;

  transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  client = new Client({ name: "company-chatbot", version: "1.0.0" });
  await client.connect(transport);
  console.log("[MCP Client] Connected to", MCP_URL);
  return client;
}

async function ensureConnected() {
  if (client) {
    try {
      await client.ping();
      return client;
    } catch {
      console.log("[MCP Client] Connection lost, reconnecting...");
    }
  }
  return connect();
}

/**
 * Fetches MCP tools and converts them to OpenAI-compatible tool definitions.
 */
async function getToolDefinitions() {
  if (toolCache) return toolCache;

  const c = await ensureConnected();
  const { tools } = await c.listTools();

  toolCache = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));

  console.log(
    `[MCP Client] Loaded ${toolCache.length} tools:`,
    toolCache.map((t) => t.function.name).join(", ")
  );
  return toolCache;
}

/**
 * Call a tool on the MCP server by name with given arguments.
 */
async function callTool(name, args) {
  const c = await ensureConnected();
  const result = await c.callTool({ name, arguments: args });

  const textContent = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");

  try {
    return JSON.parse(textContent);
  } catch {
    return textContent;
  }
}

async function executeTool(name, args) {
  return callTool(name, args);
}

module.exports = { getToolDefinitions, callTool, executeTool };
