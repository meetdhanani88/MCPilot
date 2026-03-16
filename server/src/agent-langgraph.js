const { ChatGroq } = require("@langchain/groq");
const {
  StateGraph,
  Annotation,
  END,
  START,
  MemorySaver,
  interrupt,
  Command,
} = require("@langchain/langgraph");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} = require("@langchain/core/messages");
const { callTool: mcpCallTool } = require("./mcp/client");

// ─── LLM Setup ───
function makeLLM(temperature = 0.3) {
  return new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
    temperature,
  });
}

// ─── Tools (LangChain wrappers that delegate to MCP server) ───

const queryDatabase = tool(
  async ({ sql }) => {
    const result = await mcpCallTool("query_database", { sql });
    return JSON.stringify(result);
  },
  {
    name: "query_database",
    description:
      "Run a read-only SQL SELECT query. Tables: employees (id, name, email, department, role, join_date, salary), products (id, name, category, price, stock), orders (id, customer_name, product_id, quantity, total, order_date, status).",
    schema: z.object({ sql: z.string() }),
  }
);

const searchDocuments = tool(
  async ({ query }) => {
    const result = await mcpCallTool("search_documents", { query });
    return JSON.stringify(result);
  },
  {
    name: "search_documents",
    description: "Search company documents (policies, guides, FAQs) by keyword.",
    schema: z.object({ query: z.string() }),
  }
);

// ─── Helper: call LLM with tools until done ───
async function agentToolLoop(systemPrompt, question, tools, maxRounds = 5) {
  const llm = makeLLM();
  const llmWithTools = llm.bindTools(tools);
  const messages = [new SystemMessage(systemPrompt), new HumanMessage(question)];

  for (let i = 0; i < maxRounds; i++) {
    const response = await llmWithTools.invoke(messages);
    messages.push(response);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return response.content;
    }

    for (const tc of response.tool_calls) {
      const toolFn = tools.find((t) => t.name === tc.name);
      const result = toolFn ? await toolFn.invoke(tc.args) : "Tool not found";
      messages.push(new ToolMessage({ content: result, tool_call_id: tc.id }));
    }
  }

  return messages[messages.length - 1].content || "Could not complete in time.";
}

// ═══════════════════════════════════════════════════════════════
// GRAPH STATE — all data that flows through the graph
// ═══════════════════════════════════════════════════════════════

const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  query: Annotation({
    reducer: (_, next) => next,
    default: () => "",
  }),
  route: Annotation({
    reducer: (_, next) => next,
    default: () => "",
  }),
  dbResult: Annotation({
    reducer: (_, next) => next,
    default: () => "",
  }),
  docResult: Annotation({
    reducer: (_, next) => next,
    default: () => "",
  }),
  analysis: Annotation({
    reducer: (_, next) => next,
    default: () => "",
  }),
  retryCount: Annotation({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  approved: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),
  events: Annotation({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

// ═══════════════════════════════════════════════════════════════
// NODE 1: ROUTER — classifies question into 5 categories
// ═══════════════════════════════════════════════════════════════

async function routerNode(state) {
  const question = state.query;
  console.log(`[LangGraph] Router: classifying "${question}"`);

  const llm = makeLLM(0);
  const response = await llm.invoke([
    new SystemMessage(
      `Classify this question into exactly ONE category. Reply with ONLY the category name.

Categories:
- DATABASE: questions about employees, products, orders, counts, salaries, lists of data
- DOCUMENTS: questions about policies, guides, onboarding, leave, expenses, procedures
- BOTH: questions that need BOTH database data AND document/policy info to answer properly (e.g. "How many leave days do engineers get?" needs employee data + leave policy)
- SENSITIVE: questions asking for individual salary info, personal data, or anything that should require approval (e.g. "What is Priya's salary?", "Show me all salaries")
- GENERAL: greetings, off-topic, unclear questions`
    ),
    new HumanMessage(question),
  ]);

  const raw = response.content.trim().toUpperCase();
  let route = "general";
  if (raw.includes("DATABASE")) route = "database";
  else if (raw.includes("DOCUMENT")) route = "documents";
  else if (raw.includes("BOTH")) route = "both";
  else if (raw.includes("SENSITIVE")) route = "sensitive";

  console.log(`[LangGraph] Router decided: ${route}`);

  return {
    route,
    events: [{ type: "route", route }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 2: DATABASE AGENT — queries company database
// ═══════════════════════════════════════════════════════════════

async function dbAgentNode(state) {
  console.log("[LangGraph] DB Agent: querying database...");

  const result = await agentToolLoop(
    "You are a database assistant. Use query_database to answer the question. Available tables: employees (id, name, email, department, role, join_date, salary), products (id, name, category, price, stock), orders (id, customer_name, product_id, quantity, total, order_date, status).",
    state.query,
    [queryDatabase]
  );

  return {
    dbResult: result,
    events: [{ type: "node", name: "DB Agent", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 3: DOCUMENT AGENT — searches company docs
// ═══════════════════════════════════════════════════════════════

async function docAgentNode(state) {
  console.log("[LangGraph] Doc Agent: searching documents...");

  const result = await agentToolLoop(
    "You are a document assistant. Use search_documents to find relevant company policies and guides. Summarize what you find clearly.",
    state.query,
    [searchDocuments]
  );

  return {
    docResult: result,
    events: [{ type: "node", name: "Doc Agent", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 4: VALIDATOR — checks if DB result is empty/useful
// (CONDITIONAL EDGE: if empty → fallback, if has data → analyzer)
// ═══════════════════════════════════════════════════════════════

async function validatorNode(state) {
  console.log("[LangGraph] Validator: checking result quality...");

  const result = state.dbResult || "";
  const isEmpty =
    result.includes("0 rows") ||
    result.includes("no data") ||
    result.includes("no results") ||
    result.includes("[]") ||
    result.trim().length < 20;

  if (isEmpty) {
    console.log("[LangGraph] Validator: result is EMPTY, will retry");
    return {
      events: [{ type: "node", name: "Validator", status: "empty — retrying" }],
    };
  }

  console.log("[LangGraph] Validator: result has DATA");
  return {
    events: [{ type: "node", name: "Validator", status: "has data" }],
  };
}

// Routing function for validator conditional edge
function validatorRouter(state) {
  const result = state.dbResult || "";
  const isEmpty =
    result.includes("0 rows") ||
    result.includes("no data") ||
    result.includes("no results") ||
    result.includes("[]") ||
    result.trim().length < 20;

  if (isEmpty && state.retryCount < 2) return "fallback";
  return "analyzer";
}

// ═══════════════════════════════════════════════════════════════
// NODE 5: FALLBACK — retries with a broader/different query
// (Demonstrates CONDITIONAL EDGE retry logic)
// ═══════════════════════════════════════════════════════════════

async function fallbackNode(state) {
  console.log(
    `[LangGraph] Fallback: retry #${state.retryCount + 1} with broader approach...`
  );

  const result = await agentToolLoop(
    `You are a database assistant. The previous query returned no results. Try a BROADER or DIFFERENT SQL query to find relevant data.
For example:
- If the original used WHERE with a specific value, try LIKE with wildcards
- If searching by exact name, try partial match
- If the table was wrong, try a different table
Available tables: employees, products, orders.`,
    `Original question: "${state.query}". Previous attempt returned empty results. Try a different approach.`,
    [queryDatabase]
  );

  return {
    dbResult: result,
    retryCount: state.retryCount + 1,
    events: [{ type: "node", name: "Fallback Agent", status: "retried" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 6: HUMAN APPROVAL — pauses graph for user approval
// (Demonstrates HUMAN-IN-THE-LOOP with interrupt)
// ═══════════════════════════════════════════════════════════════

async function humanApprovalNode(state) {
  console.log("[LangGraph] Human Approval: requesting permission...");

  const decision = interrupt({
    question: `This query involves sensitive employee data: "${state.query}". Do you approve?`,
    type: "approval_needed",
  });

  console.log(`[LangGraph] Human Approval: user said "${decision}"`);

  if (decision === "approved") {
    return {
      approved: true,
      events: [{ type: "node", name: "Human Approval", status: "approved" }],
    };
  }

  return {
    approved: false,
    messages: [
      new AIMessage(
        "This query was rejected for privacy reasons. I can only share aggregated data (totals, averages, counts) without approval for individual records."
      ),
    ],
    events: [{ type: "node", name: "Human Approval", status: "rejected" }],
  };
}

function approvalRouter(state) {
  return state.approved ? "db_agent_sensitive" : END;
}

// Separate DB agent node for sensitive queries (after approval)
async function dbAgentSensitiveNode(state) {
  console.log("[LangGraph] DB Agent (approved): querying sensitive data...");

  const result = await agentToolLoop(
    "You are a database assistant with APPROVED access to sensitive data. Answer the query using query_database. You may show individual employee details since the user approved this access.",
    state.query,
    [queryDatabase]
  );

  return {
    dbResult: result,
    events: [{ type: "node", name: "DB Agent (Approved)", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 7: PARALLEL COMBINER — merges DB + Doc results
// (Called after PARALLEL execution of DB + Doc agents)
// ═══════════════════════════════════════════════════════════════

async function combinerNode(state) {
  console.log("[LangGraph] Combiner: merging DB + Doc results...");

  return {
    events: [{ type: "node", name: "Combiner", status: "merged" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 8: ANALYZER — finds patterns and insights in data
// ═══════════════════════════════════════════════════════════════

async function analyzerNode(state) {
  console.log("[LangGraph] Analyzer: finding insights...");

  const llm = makeLLM();
  const context = [state.dbResult, state.docResult].filter(Boolean).join("\n\n");

  const response = await llm.invoke([
    new SystemMessage(
      `You are a data analyst. Given the following data, provide:
1. Key findings or numbers
2. Any notable patterns or insights
3. If both database results and documents are present, connect the dots between them.
Be concise — 2-3 bullet points max.`
    ),
    new HumanMessage(
      `Original question: "${state.query}"\n\nData collected:\n${context}`
    ),
  ]);

  return {
    analysis: response.content,
    events: [{ type: "node", name: "Analyzer", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 9: SUMMARIZER — produces the final user-friendly answer
// ═══════════════════════════════════════════════════════════════

async function summarizerNode(state) {
  console.log("[LangGraph] Summarizer: creating final answer...");

  const llm = makeLLM();
  const parts = [];
  if (state.dbResult) parts.push(`Database results:\n${state.dbResult}`);
  if (state.docResult) parts.push(`Document results:\n${state.docResult}`);
  if (state.analysis) parts.push(`Analysis:\n${state.analysis}`);

  const response = await llm.invoke([
    new SystemMessage(
      `You are a friendly company assistant. Create a clear, well-formatted final answer for the user based on the data below. Use bullet points and bold text where helpful. Cite whether info came from the database or documents. Keep it concise.`
    ),
    new HumanMessage(
      `Question: "${state.query}"\n\n${parts.join("\n\n")}`
    ),
  ]);

  return {
    messages: [new AIMessage(response.content)],
    events: [{ type: "node", name: "Summarizer", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// NODE 10: GENERAL — handles greetings and off-topic
// ═══════════════════════════════════════════════════════════════

async function generalNode(state) {
  console.log("[LangGraph] General: direct response...");

  const llm = makeLLM();
  const response = await llm.invoke([
    new SystemMessage(
      "You are a friendly company assistant. If it's a greeting, respond warmly and list what you can help with (employees, products, orders, policies). If off-topic, politely redirect."
    ),
    new HumanMessage(state.query),
  ]);

  return {
    messages: [new AIMessage(response.content)],
    events: [{ type: "node", name: "General", status: "done" }],
  };
}

// ═══════════════════════════════════════════════════════════════
// BUILD THE GRAPH
//
//                         ┌──────────┐
//             START ───▶  │  Router  │
//                         └────┬─────┘
//              ╱       ╱       │       ╲        ╲
//       ┌─────▼┐ ┌────▼────┐ ┌▼──────┐ ┌▼───────┐
//       │  DB  │ │Parallel │ │Approve│ │General  │
//       │Agent │ │DB + Doc │ │(HITL) │ │         │
//       └──┬───┘ └────┬────┘ └──┬────┘ └──┬─────┘
//          ▼          ▼     yes/no         │
//     ┌────────┐ ┌────────┐  ┌──┴──┐      │
//     │Validate│ │Combiner│  │DB or│      │
//     └──┬──┬──┘ └───┬────┘  │END  │      │
//   empty│  │ok      │       └──┬──┘      │
//        ▼  │        │          │          │
//   ┌──────┐│        ▼          ▼          │
//   │Fallbk││   ┌────────┐ ┌────────┐     │
//   └──┬───┘│   │Analyzer│ │Analyzer│     │
//      └┬───┘   └───┬────┘ └───┬────┘     │
//       ▼           │          │           │
//  ┌────────┐       │          │           │
//  │Analyzer│       │          │           │
//  └───┬────┘       │          │           │
//      └──────┬─────┘──────────┘           │
//             ▼                            │
//        ┌──────────┐                      │
//        │Summarizer│◄─────────────────────┘
//        └────┬─────┘
//             ▼
//            END
// ═══════════════════════════════════════════════════════════════

const checkpointer = new MemorySaver();

function buildGraph() {
  const graph = new StateGraph(GraphState)
    // All nodes
    .addNode("router", routerNode)
    .addNode("db_agent", dbAgentNode)
    .addNode("doc_agent", docAgentNode)
    .addNode("validator", validatorNode)
    .addNode("fallback", fallbackNode)
    .addNode("human_approval", humanApprovalNode)
    .addNode("db_agent_sensitive", dbAgentSensitiveNode)
    .addNode("parallel_db", dbAgentNode)
    .addNode("parallel_doc", docAgentNode)
    .addNode("combiner", combinerNode)
    .addNode("analyzer", analyzerNode)
    .addNode("summarizer", summarizerNode)
    .addNode("general", generalNode)

    // START → Router
    .addEdge(START, "router")

    // Router → 5 branches (CONDITIONAL EDGES)
    .addConditionalEdges("router", (state) => {
      switch (state.route) {
        case "database":
          return "db_agent";
        case "documents":
          return "doc_agent";
        case "both":
          return ["parallel_db", "parallel_doc"]; // PARALLEL EXECUTION
        case "sensitive":
          return "human_approval";
        default:
          return "general";
      }
    })

    // DATABASE path: DB Agent → Validator → (conditional) → Analyzer → Summarizer
    .addEdge("db_agent", "validator")
    .addConditionalEdges("validator", validatorRouter)
    .addEdge("fallback", "validator") // retry loops back to validator

    // DOCUMENT path: Doc Agent → Summarizer
    .addEdge("doc_agent", "summarizer")

    // PARALLEL path: both agents → Combiner → Analyzer → Summarizer
    .addEdge("parallel_db", "combiner")
    .addEdge("parallel_doc", "combiner")
    .addEdge("combiner", "analyzer")

    // SENSITIVE path: Human Approval → (approved: DB agent, rejected: END)
    .addConditionalEdges("human_approval", approvalRouter)
    .addEdge("db_agent_sensitive", "analyzer")

    // Analyzer → Summarizer → END
    .addEdge("analyzer", "summarizer")
    .addEdge("summarizer", END)
    .addEdge("general", END);

  return graph.compile({ checkpointer });
}

const app = buildGraph();

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

async function runLangGraphAgent(userMessage, threadId) {
  console.log(`\n[LangGraph] ═══ Processing: "${userMessage}" (thread: ${threadId}) ═══`);

  const config = { configurable: { thread_id: threadId } };

  const result = await app.invoke(
    { query: userMessage, messages: [new HumanMessage(userMessage)] },
    config
  );

  // Check if graph was interrupted (human approval needed)
  if (result.__interrupt__ && result.__interrupt__.length > 0) {
    const interruptData = result.__interrupt__[0].value;
    console.log("[LangGraph] Graph interrupted for approval");
    return {
      reply: null,
      interrupted: true,
      interruptData,
      threadId,
      events: result.events || [],
    };
  }

  const aiMessages = result.messages.filter(
    (m) => m instanceof AIMessage || m._getType?.() === "ai"
  );
  const lastAI = aiMessages[aiMessages.length - 1];

  return {
    reply: lastAI?.content || "Sorry, I couldn't generate a response.",
    interrupted: false,
    route: result.route,
    events: result.events || [],
    threadId,
  };
}

async function resumeLangGraphAgent(threadId, decision) {
  console.log(`[LangGraph] Resuming thread ${threadId} with: ${decision}`);

  const config = { configurable: { thread_id: threadId } };
  const result = await app.invoke(new Command({ resume: decision }), config);

  const aiMessages = result.messages.filter(
    (m) => m instanceof AIMessage || m._getType?.() === "ai"
  );
  const lastAI = aiMessages[aiMessages.length - 1];

  return {
    reply: lastAI?.content || "Sorry, I couldn't generate a response.",
    route: result.route,
    events: result.events || [],
    threadId,
  };
}

module.exports = { runLangGraphAgent, resumeLangGraphAgent, Command };
