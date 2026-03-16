const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const DOCS_DIR =
  process.env.DOCS_DIR || path.join(__dirname, "../../data/docs");

function loadDocuments() {
  if (!fs.existsSync(DOCS_DIR)) return [];
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".txt") || f.endsWith(".md"))
    .map((filename) => ({
      filename,
      content: fs.readFileSync(path.join(DOCS_DIR, filename), "utf-8"),
    }));
}

function register(server) {
  server.registerTool(
    "search_documents",
    {
      title: "Search Documents",
      description:
        "Search company internal documents (policies, guides, FAQs) by keyword. Returns matching excerpts with filenames.",
      inputSchema: {
        query: z
          .string()
          .describe("Keywords to search for in company documents."),
      },
    },
    async ({ query }) => {
      const docs = loadDocuments();
      const keywords = query.toLowerCase().split(/\s+/);
      const results = [];

      for (const doc of docs) {
        const lower = doc.content.toLowerCase();
        const matches = keywords.filter((kw) => lower.includes(kw));
        if (matches.length > 0) {
          const matchingLines = doc.content
            .split("\n")
            .filter((line) =>
              keywords.some((kw) => line.toLowerCase().includes(kw))
            )
            .slice(0, 5);

          results.push({
            filename: doc.filename,
            relevance: matches.length / keywords.length,
            excerpts: matchingLines,
          });
        }
      }

      results.sort((a, b) => b.relevance - a.relevance);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: results.slice(0, 5),
              total: results.length,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_document",
    {
      title: "Get Document",
      description:
        "Get the full content of a specific company document by filename.",
      inputSchema: {
        filename: z
          .string()
          .describe("The filename of the document to retrieve."),
      },
    },
    async ({ filename }) => {
      const filePath = path.join(DOCS_DIR, path.basename(filename));
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Document "${filename}" not found.` }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              filename,
              content: fs.readFileSync(filePath, "utf-8"),
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List Documents",
      description: "List all available company documents.",
      inputSchema: {},
    },
    async () => {
      const docs = loadDocuments();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              documents: docs.map((d) => ({
                filename: d.filename,
                size: d.content.length,
                preview: d.content.slice(0, 100) + "...",
              })),
            }),
          },
        ],
      };
    }
  );
}

module.exports = { register };
