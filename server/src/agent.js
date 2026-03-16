const OpenAI = require("openai");
const { getToolDefinitions, executeTool } = require("./mcp/client");

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLM(params, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      if (err.status === 429 && attempt < retries - 1) {
        const wait = Math.min((attempt + 1) * 10000, 60000);
        console.log(`[Agent] Rate limited. Waiting ${wait / 1000}s before retry (attempt ${attempt + 1}/${retries})...`);
        await sleep(wait);
      } else if (err.status === 429) {
        throw new Error("Rate limit exceeded. Please wait a minute and try again.");
      } else if (err.status === 400 && err.code === "tool_use_failed") {
        console.log(`[Agent] Tool call format error, retrying...`);
        if (attempt < retries - 1) {
          await sleep(1000);
          continue;
        }
        throw err;
      } else {
        throw err;
      }
    }
  }
}

const MODEL = () => process.env.LLM_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are a helpful company assistant. You answer questions ONLY using the tools available to you.

Rules:
- Always use tools to fetch real data before answering. Never make up information.
- If a question is outside the company scope, politely say you can only help with company-related queries.
- When you get data from tools, summarize it clearly for the user.
- Cite which source (database, documents) your answer came from.
- Call only one tool at a time. Do not call multiple tools in parallel.`;

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  const toolDefinitions = await getToolDefinitions();
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    const response = await callLLM({
      model: MODEL(),
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
      parallel_tool_calls: false,
      temperature: 0.3,
    });

    const choice = response.choices[0].message;
    messages.push(choice);

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      return {
        reply: choice.content,
        messages,
      };
    }

    for (const toolCall of choice.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[Agent] Calling tool: ${toolCall.function.name}`, args);

      let result;
      try {
        result = await executeTool(toolCall.function.name, args);
        console.log(`[Agent] Tool result:`, JSON.stringify(result).slice(0, 200));
      } catch (err) {
        result = { error: err.message };
        console.log(`[Agent] Tool error:`, err.message);
      }

      console.log(`[Agent] Tool result:`, JSON.stringify(result).slice(0, 200));

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply: "I'm sorry, I wasn't able to find an answer after multiple attempts. Please try rephrasing your question.",
    messages,
  };
}

async function* runAgentStream(userMessage, conversationHistory = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  const toolDefinitions = await getToolDefinitions();
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    console.log(`[Agent] Iteration ${i + 1}, sending to LLM...`);

    const response = await callLLM({
      model: MODEL(),
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
      parallel_tool_calls: false,
      temperature: 0.3,
    });

    const choice = response.choices[0].message;
    messages.push(choice);

    console.log(`[Agent] LLM responded. Tool calls: ${choice.tool_calls?.length || 0}, Content: ${(choice.content || "").slice(0, 100)}`);

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      const content = choice.content || "";
      for (const char of content) {
        yield { type: "token", content: char };
      }
      yield { type: "done" };
      return;
    }

    for (const toolCall of choice.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[Agent] Tool call: ${toolCall.function.name}`, args);

      yield { type: "tool_call", name: toolCall.function.name, args };

      let result;
      try {
        result = await executeTool(toolCall.function.name, args);
        console.log(`[Agent] Tool result:`, JSON.stringify(result).slice(0, 200));
      } catch (err) {
        result = { error: err.message };
        console.log(`[Agent] Tool error:`, err.message);
      }

      yield { type: "tool_result", name: toolCall.function.name, result };

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
}

module.exports = { runAgent, runAgentStream };
