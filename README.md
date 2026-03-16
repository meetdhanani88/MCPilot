# Company AI Assistant

A ChatGPT-like web application for answering company-specific questions. It queries a company database and searches internal documents using an AI agent that decides which tools to call, all built on the Model Context Protocol (MCP).

## Architecture

The project is a **monorepo with three independent services**:

```
Browser (:5173)  -->  Express API (:3000)  -->  MCP Server (:4000)
   React UI              AI Agent               Database + Docs
```

```
company-chatbot/
├── mcp-server/       Standalone MCP server (data layer)
├── server/           Express.js backend (AI agent + API)
├── frontend/         React app (chat UI)
└── package.json      Root orchestrator scripts
```

### How a question flows through the system

```
User: "How many employees are there?"
 │
 ▼
┌─────────────────────────────────────────────────────────┐
│ FRONTEND (React, port 5173)                             │
│                                                         │
│  ChatInput → POST /api/chat/stream → parse SSE stream   │
│  Display: ToolStatus → ChatMessage                      │
└────────────────────┬────────────────────────────────────┘
                     │ Vite proxies /api/* to :3000
                     ▼
┌─────────────────────────────────────────────────────────┐
│ SERVER (Express, port 3000)                             │
│                                                         │
│  1. Receives message                                    │
│  2. Agent sends message + tool definitions to LLM       │
│  3. LLM responds: "call query_database with             │
│     SELECT COUNT(*) FROM employees"                     │
│  4. Agent calls MCP server via MCP Client               │
│  5. Gets result: { rows: [{count: 10}] }                │
│  6. Feeds result back to LLM                            │
│  7. LLM generates: "There are 10 employees"             │
│  8. Streams response back to frontend via SSE           │
└────────────────────┬────────────────────────────────────┘
                     │ MCP protocol over HTTP
                     ▼
┌─────────────────────────────────────────────────────────┐
│ MCP SERVER (port 4000)                                  │
│                                                         │
│  Receives JSON-RPC tool call                            │
│  Executes: SELECT COUNT(*) FROM employees               │
│  Returns: { rows: [{count: 10}], count: 1 }             │
└─────────────────────────────────────────────────────────┘
```

## The Three Services

### 1. MCP Server (`mcp-server/`, port 4000)

A **standalone Model Context Protocol server** built with the official `@modelcontextprotocol/sdk`. It owns the company data and exposes it through 5 tools that any MCP client can use.

**Tools exposed:**

| Tool | Description |
|------|-------------|
| `query_database` | Run read-only SQL SELECT queries against the company SQLite database |
| `list_tables` | List all tables and their columns |
| `search_documents` | Search internal docs (policies, guides) by keyword |
| `get_document` | Get full content of a specific document |
| `list_documents` | List all available documents |

**Key files:**
- `src/index.js` -- Server entry point. Supports two transport modes: **Streamable HTTP** (runs as a web server on port 4000) and **stdio** (for Cursor/Claude Desktop integration via `--stdio` flag)
- `src/tools/database.js` -- Database tools using `better-sqlite3`
- `src/tools/documents.js` -- Document search tools using the filesystem
- `data/company.db` -- SQLite database with employees, products, and orders tables
- `data/docs/` -- Markdown documents (leave policy, onboarding guide, expense policy)
- `scripts/seed.js` -- Seeds the database and creates sample documents

**This server is completely independent.** You can host it anywhere, and any MCP-compatible client (your chatbot, Cursor, Claude Desktop) can connect to it.

### 2. Server (`server/`, port 3000)

The **Express.js API backend** that acts as the brain. It connects to the MCP server as a client, talks to an LLM (Groq), and orchestrates the agent loop.

**Two agent modes:**

| Mode | File | Description |
|------|------|-------------|
| Simple Agent | `src/agent.js` | Direct agent loop: LLM decides tools, calls them, generates answer |
| LangGraph Agent | `src/agent-langgraph.js` | Advanced state machine with routing, validation, retries, parallel execution, and human-in-the-loop approval |

**The Agent Loop (Simple Agent):**
1. User message + tool definitions are sent to the LLM
2. LLM either returns a final answer or requests a tool call
3. If tool call: execute it via MCP client, feed result back to LLM
4. Repeat until LLM returns a final answer (max 10 iterations)

**The LangGraph Agent** is a state machine with these nodes:

```
                       ┌──────────┐
           START ───>  │  Router  │
                       └────┬─────┘
            ╱       ╱       │       ╲        ╲
     ┌─────▼┐ ┌────▼────┐ ┌▼──────┐ ┌▼───────┐ ┌▼────────┐
     │  DB  │ │  Doc    │ │Both   │ │Approve │ │General  │
     │Agent │ │ Agent   │ │(para.)│ │(HITL)  │ │         │
     └──┬───┘ └────┬────┘ └──┬────┘ └──┬─────┘ └──┬──────┘
        ▼          │      ┌──┴──┐   yes/no         │
   ┌────────┐      │  DB + Doc  │   ┌──┴──┐       │
   │Validate│      │  parallel  │   │DB or│       │
   └──┬──┬──┘      │  └──┬──┘   │   │ END │       │
 empty│  │ok       │ ┌───▼────┐ │   └──┬──┘       │
      ▼  │         │ │Combiner│ │      │           │
 ┌──────┐│         │ └───┬────┘ │      │           │
 │Fallbk││         │     │      │      │           │
 └──┬───┘│         │     ▼      │      ▼           │
    └┬───┘         │ ┌────────┐ │ ┌────────┐       │
     ▼             │ │Analyzer│ │ │Analyzer│       │
┌────────┐         │ └───┬────┘ │ └───┬────┘       │
│Analyzer│         │     │      │     │             │
└───┬────┘         │     │      │     │             │
    └──────┬───────┘─────┘──────┘─────┘             │
           ▼                                        │
      ┌──────────┐                                  │
      │Summarizer│◄─────────────────────────────────┘
      └────┬─────┘
           ▼
          END
```

- **Router**: LLM classifies the question into database / documents / both / sensitive / general
- **Validator + Fallback**: If DB returns empty, retry with a broader query (max 2 retries)
- **Human Approval**: Sensitive queries (salaries, personal data) pause for user approval
- **Parallel Execution**: "Both" queries run DB and Doc agents simultaneously
- **Analyzer**: LLM extracts insights from raw data
- **Summarizer**: LLM creates the final user-friendly answer

**Key files:**
- `src/server.js` -- Express API with endpoints for both agent modes and SSE streaming
- `src/agent.js` -- Simple agent with tool-calling loop
- `src/agent-langgraph.js` -- LangGraph state machine agent
- `src/mcp/client.js` -- MCP client that connects to the MCP server over Streamable HTTP. Converts MCP tool schemas to OpenAI-compatible format for the LLM

**API Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat/stream` | Simple agent (SSE streaming) |
| POST | `/api/chat/langgraph` | LangGraph agent (SSE streaming) |
| POST | `/api/chat/langgraph/resume` | Resume after human approval |
| POST | `/api/chat` | Simple agent (non-streaming) |

### 3. Frontend (`frontend/`, port 5173)

A **React** single-page application built with Vite. Dark-themed chat interface.

**Components:**
- `App.jsx` -- Main layout, renders all components, manages engine toggle
- `ChatMessage.jsx` -- Renders user/assistant messages with basic Markdown formatting
- `ToolStatus.jsx` -- Shows spinning/done indicators when tools are being called
- `ApprovalDialog.jsx` -- UI for human-in-the-loop approval (approve/reject buttons)
- `ChatInput.jsx` -- Auto-resizing textarea with send button
- `Welcome.jsx` -- Landing screen with suggestion buttons
- `TypingIndicator.jsx` -- Animated dots while waiting for response

**Custom Hook:**
- `hooks/useChat.js` -- All chat logic: sends messages, parses SSE streams, handles tool events, manages approval flow

**Engine Toggle:** A button in the header switches between "Simple Agent" and "LangGraph" mode, changing which backend endpoint is called.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| MCP Server | `@modelcontextprotocol/sdk`, `better-sqlite3`, Express | Expose data as MCP tools |
| Backend | Express.js, `openai` SDK (pointing to Groq), LangGraph | AI agent orchestration |
| Frontend | React, Vite | Chat UI |
| LLM | Groq API (Llama / Kimi models) | Natural language understanding + tool calling |
| Database | SQLite | Company data (employees, products, orders) |
| Protocol | MCP (Streamable HTTP) | Standardized tool communication |
| Streaming | Server-Sent Events (SSE) | Real-time response streaming |

## Quick Start

### Prerequisites

- Node.js 18+
- A Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Install all dependencies

```bash
npm run install:all
```

### 2. Seed the database

```bash
npm run seed
```

This creates `mcp-server/data/company.db` with sample data (10 employees, 8 products, 8 orders) and 3 markdown documents.

### 3. Configure environment

Edit `server/.env` and set your Groq API key:

```
GROQ_API_KEY=your_key_here
LLM_MODEL=moonshotai/kimi-k2-instruct-0905
PORT=3000
MCP_SERVER_URL=http://localhost:4000/mcp
```

### 4. Start all services

```bash
npm run dev
```

This starts all three services in parallel:
- MCP Server on http://localhost:4000
- Express API on http://localhost:3000
- React UI on http://localhost:5173

Open **http://localhost:5173** in your browser.

### Start services individually

```bash
npm run dev:mcp        # MCP server only (port 4000)
npm run dev:server     # Express backend only (port 3000)
npm run dev:frontend   # React frontend only (port 5173)
```

## Using the MCP Server with Cursor / Claude Desktop

The MCP server is a standalone, standard-compliant MCP server. You can connect to it from any MCP client.

### Cursor (HTTP -- server must be running)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "company-data": {
      "url": "http://localhost:4000/mcp"
    }
  }
}
```

### Cursor / Claude Desktop (stdio -- auto-launched)

```json
{
  "mcpServers": {
    "company-data": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/src/index.js", "--stdio"]
    }
  }
}
```

## Sessions

There are three independent session mechanisms, one at each layer:

### MCP Protocol Session (MCP Client <-> MCP Server)

A JSON-RPC session between the Express backend and the MCP server, managed by the `@modelcontextprotocol/sdk`.

```
Express Server                          MCP Server (:4000)
     │                                       │
     │  POST /mcp  {initialize}              │  No Mcp-Session-Id header
     │ ──────────────────────────────────►    │  → creates new transport + UUID
     │                                       │
     │  Response + Mcp-Session-Id: abc-123   │
     │ ◄──────────────────────────────────   │  transports["abc-123"] = transport
     │                                       │
     │  POST /mcp  {tools/list}              │  Mcp-Session-Id: abc-123
     │ ──────────────────────────────────►    │  → looks up transport by "abc-123"
     │                                       │
     │  POST /mcp  {tools/call}              │  Mcp-Session-Id: abc-123
     │ ──────────────────────────────────►    │  → same transport handles it
```

The MCP server (`mcp-server/src/index.js`) stores transports in an in-memory map keyed by session ID. The session ID is a UUID generated during the `initialize` handshake. The MCP client (`server/src/mcp/client.js`) maintains a long-lived connection and automatically includes the session header on all subsequent requests.

### Conversation Session (Frontend <-> Express Server)

Tracks chat history so follow-up questions have context. Uses a UUID and an in-memory `Map`.

```
Frontend                              Express Server
     │                                       │
     │  POST /api/chat/stream                │
     │  { message: "How many employees?" }   │  No conversationId
     │ ─────────────────────────────────►    │  → id = crypto.randomUUID()
     │                                       │  → conversations.set(id, history)
     │  SSE: { type: "done",                │
     │         conversationId: "xyz-789" }   │
     │ ◄─────────────────────────────────    │
     │                                       │
     │  POST /api/chat/stream                │
     │  { message: "Which department?",      │  Has conversationId
     │    conversationId: "xyz-789" }         │  → history = conversations.get(id)
     │ ─────────────────────────────────►    │  → Agent sees prior Q&A as context
```

The frontend stores the `conversationId` in React state (`useChat` hook) and sends it with every subsequent message. The Express server stores full message history in a `Map<string, Message[]>`.

### LangGraph Thread Session (Human-in-the-Loop Approval)

When the LangGraph agent encounters a sensitive query, it pauses mid-execution using `interrupt()`. The `MemorySaver` checkpointer persists the full graph state in memory so it can resume later.

```
Frontend                    Express Server              LangGraph
     │                             │                          │
     │  "What is Priya's salary?"  │                          │
     │ ──────────────────────►     │  invoke(thread: "t1")    │
     │                             │ ────────────────────►    │
     │                             │                          │ Router → sensitive
     │                             │                          │ interrupt() ← PAUSES
     │                             │                          │ State saved by MemorySaver
     │  SSE: approval_needed       │  result.interrupted=true │
     │  { threadId: "t1" }         │ ◄────────────────────    │
     │ ◄──────────────────────     │                          │
     │                             │                          │
     │  [User clicks Approve]      │                          │
     │                             │                          │
     │  POST /resume               │                          │
     │  { threadId: "t1",          │  invoke(Command({resume})│
     │    decision: "approved" }   │    thread_id: "t1")      │
     │ ──────────────────────►     │ ────────────────────►    │
     │                             │                          │ Loads state from MemorySaver
     │                             │                          │ Resumes → DB Agent → ...
     │  SSE: tokens + done         │  result.reply            │
     │ ◄──────────────────────     │ ◄────────────────────    │
```

The `thread_id` is the session key. `MemorySaver` stores the entire graph state (current node, all state values) keyed by `thread_id`.

### Session summary

| Session | Where | Key | Storage | Lifetime |
|---------|-------|-----|---------|----------|
| MCP Protocol | MCP Server | `Mcp-Session-Id` header | `transports` map | Until client disconnects |
| Conversation | Express Server | `conversationId` UUID | `conversations` Map | Until server restarts |
| LangGraph Thread | Express Server | `threadId` UUID | `MemorySaver` (in-memory) | Until server restarts |

All three are in-memory only and reset when the respective server restarts. For production, you would swap these for Redis, a database, or a persistent checkpointer.

## Sample Questions

| Question | What happens |
|----------|-------------|
| "How many employees are there?" | Router -> DB Agent -> Validator -> Analyzer -> Summarizer |
| "What is the leave policy?" | Router -> Doc Agent -> Summarizer |
| "Compare engineering salaries with the expense policy" | Router -> Parallel (DB + Doc) -> Combiner -> Analyzer -> Summarizer |
| "What is Priya's salary?" | Router -> Human Approval -> (if approved) DB Agent -> Analyzer -> Summarizer |
| "Hello!" | Router -> General (direct LLM response) |

## Project Structure

```
company-chatbot/
├── package.json                     Root scripts (dev, seed, install:all)
├── README.md                        This file
│
├── mcp-server/                      STANDALONE MCP SERVER (port 4000)
│   ├── package.json
│   ├── .env                         PORT config
│   ├── src/
│   │   ├── index.js                 McpServer + Streamable HTTP / stdio
│   │   └── tools/
│   │       ├── database.js          query_database, list_tables
│   │       └── documents.js         search_documents, get_document, list_documents
│   ├── data/
│   │   ├── company.db               SQLite database
│   │   └── docs/                    Markdown documents
│   └── scripts/
│       └── seed.js                  Database + docs seeder
│
├── server/                          EXPRESS BACKEND (port 3000)
│   ├── package.json
│   ├── .env                         GROQ_API_KEY, LLM_MODEL, MCP_SERVER_URL
│   └── src/
│       ├── server.js                Express API + SSE streaming endpoints
│       ├── agent.js                 Simple agent (LLM + tool loop)
│       ├── agent-langgraph.js       LangGraph state machine agent
│       └── mcp/
│           └── client.js            MCP client (connects to mcp-server)
│
└── frontend/                        REACT APP (port 5173)
    ├── package.json
    ├── vite.config.js               Dev server + proxy /api -> :3000
    ├── index.html
    └── src/
        ├── main.jsx                 Entry point
        ├── App.jsx                  Main app component
        ├── styles.css               All styles (dark theme)
        ├── hooks/
        │   └── useChat.js           Chat logic + SSE stream parsing
        └── components/
            ├── Welcome.jsx          Landing screen with suggestions
            ├── ChatMessage.jsx      Message bubble with Markdown
            ├── ChatInput.jsx        Auto-resize textarea + send
            ├── ToolStatus.jsx       Tool call spinner / checkmark
            ├── ApprovalDialog.jsx   Human-in-the-loop approval UI
            └── TypingIndicator.jsx  Animated typing dots
```
