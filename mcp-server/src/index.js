const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const express = require("express");

const databaseTools = require("./tools/database.js");
const documentTools = require("./tools/documents.js");

function createServer() {
  const server = new McpServer({
    name: "company-data",
    version: "1.0.0",
  });

  databaseTools.register(server);
  documentTools.register(server);

  return server;
}

// ─── stdio mode: `node src/index.js --stdio` ───
if (process.argv.includes("--stdio")) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("[MCP] Running in stdio mode");
  });
} else {
  // ─── HTTP mode (Streamable HTTP) ───
  const PORT = process.env.PORT || 4000;
  const app = express();
  app.use(express.json());

  const transports = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // sessionId is only available AFTER handleRequest processes the initialize request
    if (transport.sessionId) {
      transports[transport.sessionId] = transport;
      console.log(`[MCP Server] New session: ${transport.sessionId}`);
    }

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`[MCP Server] Session closed: ${transport.sessionId}`);
      }
    };
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "No active session. POST to /mcp first." });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      delete transports[sessionId];
    } else {
      res.status(400).json({ error: "No active session." });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", tools: 5 });
  });

  app.listen(PORT, () => {
    console.log(`\n[MCP Server] Running on http://localhost:${PORT}`);
    console.log(`[MCP Server] Endpoint: POST http://localhost:${PORT}/mcp`);
    console.log(`[MCP Server] Health:   GET  http://localhost:${PORT}/health`);
    console.log(`[MCP Server] Tools: query_database, list_tables, search_documents, get_document, list_documents\n`);
  });
}
