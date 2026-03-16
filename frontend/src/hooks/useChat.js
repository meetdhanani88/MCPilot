import { useState, useRef, useCallback } from "react";

export function useChat() {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [useLangGraph, setUseLangGraph] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  const abortRef = useRef(null);

  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateLastAssistant = useCallback((content) => {
    setMessages((prev) => {
      const copy = [...prev];
      const lastIdx = copy.findLastIndex((m) => m.role === "assistant");
      if (lastIdx >= 0) copy[lastIdx] = { ...copy[lastIdx], content };
      return copy;
    });
  }, []);

  const processStream = useCallback(
    async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      let assistantCreated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (event.type === "tool_call") {
            addMessage({
              role: "tool",
              type: "call",
              name: event.name,
              args: event.args,
            });
          } else if (event.type === "tool_result") {
            setMessages((prev) => {
              const copy = [...prev];
              const lastTool = copy.findLastIndex(
                (m) => m.role === "tool" && m.type === "call"
              );
              if (lastTool >= 0) copy[lastTool] = { ...copy[lastTool], done: true };
              return copy;
            });
          } else if (event.type === "token") {
            if (!assistantCreated) {
              addMessage({ role: "assistant", content: "" });
              assistantCreated = true;
            }
            fullText += event.content;
            updateLastAssistant(fullText);
          } else if (event.type === "done") {
            setConversationId(event.conversationId);
          } else if (event.type === "approval_needed") {
            setPendingApproval({
              threadId: event.threadId,
              question: event.question,
            });
          } else if (event.type === "error") {
            addMessage({
              role: "error",
              content: event.content,
            });
          }
        }
      }

      if (!assistantCreated && !fullText) {
        addMessage({
          role: "assistant",
          content: "I received your question but couldn't generate a response. Please try again.",
        });
      }
    },
    [addMessage, updateLastAssistant]
  );

  const sendMessage = useCallback(
    async (text) => {
      if (!text.trim() || isLoading) return;

      addMessage({ role: "user", content: text });
      setIsLoading(true);

      try {
        const endpoint = useLangGraph
          ? "/api/chat/langgraph"
          : "/api/chat/stream";

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, conversationId }),
        });

        await processStream(res);
      } catch (err) {
        addMessage({
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
        });
        console.error(err);
      }

      setIsLoading(false);
    },
    [isLoading, useLangGraph, conversationId, addMessage, processStream]
  );

  const handleApproval = useCallback(
    async (decision) => {
      if (!pendingApproval) return;

      const { threadId } = pendingApproval;
      setPendingApproval((prev) => ({ ...prev, resolved: decision }));
      setIsLoading(true);

      try {
        const res = await fetch("/api/chat/langgraph/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, decision }),
        });

        await processStream(res);
      } catch (err) {
        addMessage({
          role: "assistant",
          content: "Sorry, something went wrong resuming the request.",
        });
        console.error(err);
      }

      setIsLoading(false);
      setPendingApproval(null);
    },
    [pendingApproval, addMessage, processStream]
  );

  const toggleEngine = useCallback(() => {
    setUseLangGraph((prev) => !prev);
  }, []);

  return {
    messages,
    isLoading,
    useLangGraph,
    pendingApproval,
    sendMessage,
    handleApproval,
    toggleEngine,
  };
}
