const SUGGESTIONS = [
  "How many employees are there?",
  "Show all products under $50",
  "What is the leave policy?",
  "List recent orders",
];

export default function Welcome({ onSuggestion }) {
  return (
    <div className="welcome">
      <h2>How can I help you?</h2>
      <p>Ask me anything about your company data, employees, products, or policies.</p>
      <div className="suggestions">
        {SUGGESTIONS.map((text) => (
          <button key={text} onClick={() => onSuggestion(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
