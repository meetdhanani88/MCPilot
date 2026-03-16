function formatContent(text) {
  if (!text) return "";
  let html = text
    .replace(/```(\w+)?\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^\s*[-*]\s+(.+)/gm, "<li>$1</li>")
    .replace(/^\s*\d+\.\s+(.+)/gm, "<li>$1</li>")
    .replace(/\n/g, "<br>");

  html = html.replace(/(<li>.*?<\/li>(<br>)?)+/g, (match) => {
    const cleaned = match.replace(/<br>/g, "");
    return `<ul>${cleaned}</ul>`;
  });

  return html;
}

export default function ChatMessage({ role, content }) {
  const avatars = { user: "U", assistant: "AI" };

  return (
    <div className={`message ${role}`}>
      <div className="avatar">{avatars[role]}</div>
      <div
        className="content"
        dangerouslySetInnerHTML={{ __html: formatContent(content) }}
      />
    </div>
  );
}
