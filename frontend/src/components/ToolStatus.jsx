const TOOL_LABELS = {
  query_database: "Querying database",
  search_documents: "Searching documents",
  get_document: "Reading document",
  list_documents: "Listing documents",
  list_tables: "Listing tables",
  router: "Routing question",
  "DB Agent": "Querying database",
  "Doc Agent": "Searching documents",
  "DB Agent (Approved)": "Querying approved data",
  Validator: "Validating results",
  "Fallback Agent": "Retrying with broader query",
  "Human Approval": "Processing approval",
  Combiner: "Merging parallel results",
  Analyzer: "Analyzing data",
  Summarizer: "Writing final answer",
  General: "Generating response",
};

function summarizeArgs(name, args) {
  if (!args) return "";
  if (name === "query_database" && args.sql) {
    return args.sql.length > 60 ? args.sql.slice(0, 60) + "..." : args.sql;
  }
  if (name === "search_documents" && args.query) {
    return `"${args.query}"`;
  }
  if (name === "get_document" && args.filename) {
    return args.filename;
  }
  if (args.status) return args.status;
  return "";
}

export default function ToolStatus({ name, args, done }) {
  const label = TOOL_LABELS[name] || name;
  const detail = summarizeArgs(name, args);

  return (
    <div className={`tool-status ${done ? "done" : ""}`}>
      <div className="spinner" />
      <span className="label">{label}</span>
      {detail && <span className="detail">{detail}</span>}
    </div>
  );
}
