const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const express = require("express");
const cors = require("cors");
const { runAgent, runAgentStream } = require("./agent");
const { runLangGraphAgent, resumeLangGraphAgent } = require("./agent-langgraph");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const conversations = new Map();

app.post("/api/chat", async (req, res) => {
  const { message, conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const history = conversations.get(conversationId) || [];

  try {
    const { reply, messages } = await runAgent(message, history);

    const newHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: reply },
    ];

    const id = conversationId || crypto.randomUUID();
    conversations.set(id, newHistory);

    res.json({ reply, conversationId: id });
  } catch (err) {
    console.error("[Server] Error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  const { message, conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const history = conversations.get(conversationId) || [];
  const id = conversationId || crypto.randomUUID();

  try {
    let fullReply = "";

    console.log(`\n[Server] New message: "${message}" (conversation: ${id})`);

    for await (const event of runAgentStream(message, history)) {
      const data = JSON.stringify(event);

      if (event.type === "token") {
        fullReply += event.content;
        res.write(`data: ${data}\n\n`);
      } else if (event.type === "tool_call") {
        console.log(`[Server] → Tool call: ${event.name}(${JSON.stringify(event.args)})`);
        res.write(`data: ${data}\n\n`);
      } else if (event.type === "tool_result") {
        console.log(`[Server] ← Tool result: ${event.name} → ${JSON.stringify(event.result).slice(0, 200)}`);
        res.write(`data: ${data}\n\n`);
      } else if (event.type === "done") {
        console.log(`[Server] ✓ Reply: "${fullReply.slice(0, 150)}${fullReply.length > 150 ? "..." : ""}"`);

        const newHistory = [
          ...history,
          { role: "user", content: message },
          { role: "assistant", content: fullReply },
        ];
        conversations.set(id, newHistory);

        res.write(`data: ${JSON.stringify({ type: "done", conversationId: id })}\n\n`);
      }
    }
  } catch (err) {
    console.error("[Server] ✗ Stream error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
  }

  res.end();
});

// ─── LangGraph endpoint (advanced: routing, validation, parallel, human approval) ───
app.post("/api/chat/langgraph", async (req, res) => {
  const { message, conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const threadId = conversationId || crypto.randomUUID();

  try {
    console.log(`\n[Server:LangGraph] New message: "${message}" (thread: ${threadId})`);

    res.write(`data: ${JSON.stringify({ type: "tool_call", name: "router", args: { classifying: "question" } })}\n\n`);

    const result = await runLangGraphAgent(message, threadId);

    // Stream events from the graph (which nodes ran)
    for (const event of result.events || []) {
      if (event.type === "route") {
        res.write(`data: ${JSON.stringify({ type: "tool_result", name: "router", result: { route: event.route } })}\n\n`);
      } else if (event.type === "node") {
        res.write(`data: ${JSON.stringify({ type: "tool_call", name: event.name, args: { status: event.status } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "tool_result", name: event.name, result: { status: event.status } })}\n\n`);
      }
    }

    // If interrupted for human approval
    if (result.interrupted) {
      console.log(`[Server:LangGraph] Interrupted for approval`);
      res.write(`data: ${JSON.stringify({
        type: "approval_needed",
        threadId,
        question: result.interruptData.question,
      })}\n\n`);
      res.end();
      return;
    }

    console.log(`[Server:LangGraph] Route: ${result.route}`);
    console.log(`[Server:LangGraph] Reply: "${(result.reply || "").slice(0, 150)}..."`);

    for (const char of (result.reply || "")) {
      res.write(`data: ${JSON.stringify({ type: "token", content: char })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done", conversationId: threadId })}\n\n`);
  } catch (err) {
    console.error("[Server:LangGraph] Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
  }

  res.end();
});

// ─── LangGraph resume endpoint (after human approval/rejection) ───
app.post("/api/chat/langgraph/resume", async (req, res) => {
  const { threadId, decision } = req.body;

  if (!threadId || !decision) {
    return res.status(400).json({ error: "threadId and decision are required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    console.log(`\n[Server:LangGraph] Resuming thread ${threadId} with: ${decision}`);

    res.write(`data: ${JSON.stringify({ type: "tool_call", name: "Human Approval", args: { decision } })}\n\n`);

    const result = await resumeLangGraphAgent(threadId, decision);

    for (const event of result.events || []) {
      if (event.type === "node") {
        res.write(`data: ${JSON.stringify({ type: "tool_call", name: event.name, args: { status: event.status } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "tool_result", name: event.name, result: { status: event.status } })}\n\n`);
      }
    }

    console.log(`[Server:LangGraph] Resume reply: "${(result.reply || "").slice(0, 150)}..."`);

    for (const char of (result.reply || "")) {
      res.write(`data: ${JSON.stringify({ type: "token", content: char })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done", conversationId: threadId })}\n\n`);
  } catch (err) {
    console.error("[Server:LangGraph] Resume error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
  }

  res.end();
});

app.get("/api/conversations/:id", (req, res) => {
  const history = conversations.get(req.params.id);
  if (!history) return res.status(404).json({ error: "Conversation not found" });
  res.json({ conversationId: req.params.id, messages: history });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Company Chatbot running at http://localhost:${PORT}\n`);
});
