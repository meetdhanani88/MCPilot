const Database = require("better-sqlite3");
const path = require("path");
const { z } = require("zod");

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "../../data/company.db");

let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  }
  return db;
}

function register(server) {
  server.registerTool(
    "query_database",
    {
      title: "Query Database",
      description:
        "Run a read-only SQL query against the company database. Available tables: employees (id, name, email, department, role, join_date, salary), products (id, name, category, price, stock), orders (id, customer_name, product_id, quantity, total, order_date, status).",
      inputSchema: {
        sql: z
          .string()
          .describe("A SELECT SQL query to run. Only SELECT statements are allowed."),
      },
    },
    async ({ sql }) => {
      const normalized = sql.trim().toUpperCase();
      if (!normalized.startsWith("SELECT")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Only SELECT queries are allowed." }) }],
          isError: true,
        };
      }
      try {
        const rows = getDb().prepare(sql).all();
        return {
          content: [{ type: "text", text: JSON.stringify({ rows, count: rows.length }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_tables",
    {
      title: "List Tables",
      description:
        "List all available tables and their columns in the company database.",
      inputSchema: {},
    },
    async () => {
      const database = getDb();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();

      const result = {};
      for (const { name } of tables) {
        const columns = database.prepare(`PRAGMA table_info(${name})`).all();
        result[name] = columns.map((c) => ({ name: c.name, type: c.type }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ tables: result }) }],
      };
    }
  );
}

module.exports = { register };
