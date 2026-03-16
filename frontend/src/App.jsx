import { useEffect, useRef } from "react";
import { useChat } from "./hooks/useChat";
import Welcome from "./components/Welcome";
import ChatMessage from "./components/ChatMessage";
import ToolStatus from "./components/ToolStatus";
import ApprovalDialog from "./components/ApprovalDialog";
import ChatInput from "./components/ChatInput";
import TypingIndicator from "./components/TypingIndicator";
import "./styles.css";

export default function App() {
  const {
    messages,
    isLoading,
    useLangGraph,
    pendingApproval,
    sendMessage,
    handleApproval,
    toggleEngine,
  } = useChat();

  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingApproval, isLoading]);

  const hasMessages = messages.length > 0;

  return (
    <div className="app">
      <header>
        <h1>Company Assistant</h1>
        <span className="badge">AI Powered</span>
        <div className="engine-toggle">
          <span className="engine-label">Engine:</span>
          <button
            className={`engine-btn ${useLangGraph ? "langgraph" : ""}`}
            onClick={toggleEngine}
          >
            {useLangGraph ? "LangGraph" : "Simple Agent"}
          </button>
        </div>
      </header>

      <div className="chat-container">
        {!hasMessages && <Welcome onSuggestion={sendMessage} />}

        {messages.map((msg, i) => {
          if (msg.role === "user" || msg.role === "assistant") {
            return <ChatMessage key={i} role={msg.role} content={msg.content} />;
          }
          if (msg.role === "tool") {
            return (
              <ToolStatus
                key={i}
                name={msg.name}
                args={msg.args}
                done={msg.done}
              />
            );
          }
          if (msg.role === "error") {
            return (
              <div key={i} className="error-msg">
                {msg.content}
              </div>
            );
          }
          return null;
        })}

        {pendingApproval && (
          <ApprovalDialog
            question={pendingApproval.question}
            resolved={pendingApproval.resolved}
            onApprove={() => handleApproval("approved")}
            onReject={() => handleApproval("rejected")}
          />
        )}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <TypingIndicator />
        )}

        <div ref={chatEndRef} />
      </div>

      <ChatInput onSend={sendMessage} disabled={isLoading} />
    </div>
  );
}
