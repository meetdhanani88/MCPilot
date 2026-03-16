const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "../data");
const DOCS_DIR = path.join(DATA_DIR, "docs");

fs.mkdirSync(DOCS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "company.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  DROP TABLE IF EXISTS orders;
  DROP TABLE IF EXISTS products;
  DROP TABLE IF EXISTS employees;

  CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL,
    join_date TEXT NOT NULL,
    salary REAL NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL
  );

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_name TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    total REAL NOT NULL,
    order_date TEXT NOT NULL,
    status TEXT NOT NULL
  );
`);

const employees = [
  ["Priya Sharma", "priya@company.com", "Engineering", "Senior Developer", "2022-03-15", 95000],
  ["Rahul Patel", "rahul@company.com", "Engineering", "Tech Lead", "2021-01-10", 120000],
  ["Anita Desai", "anita@company.com", "Marketing", "Marketing Manager", "2023-06-01", 85000],
  ["Vikram Singh", "vikram@company.com", "Sales", "Sales Director", "2020-09-20", 110000],
  ["Meera Joshi", "meera@company.com", "HR", "HR Manager", "2022-11-05", 80000],
  ["Arjun Nair", "arjun@company.com", "Engineering", "Junior Developer", "2024-01-15", 65000],
  ["Sneha Reddy", "sneha@company.com", "Design", "UI/UX Lead", "2021-07-22", 90000],
  ["Karan Mehta", "karan@company.com", "Finance", "CFO", "2019-04-01", 150000],
  ["Deepa Iyer", "deepa@company.com", "Engineering", "DevOps Engineer", "2023-02-14", 92000],
  ["Amit Gupta", "amit@company.com", "Sales", "Account Executive", "2025-03-01", 70000],
];

const insertEmp = db.prepare(
  "INSERT INTO employees (name, email, department, role, join_date, salary) VALUES (?, ?, ?, ?, ?, ?)"
);
for (const emp of employees) insertEmp.run(...emp);

const products = [
  ["CloudSync Pro", "Software", 29.99, 999],
  ["DataVault Enterprise", "Software", 149.99, 500],
  ["SecureAuth Module", "Security", 79.99, 750],
  ["AnalyticsDash", "Software", 49.99, 600],
  ["DevOps Toolkit", "Infrastructure", 199.99, 300],
  ["API Gateway Plus", "Infrastructure", 99.99, 450],
  ["MobileSDK Starter", "SDK", 19.99, 2000],
  ["MobileSDK Enterprise", "SDK", 89.99, 800],
];

const insertProd = db.prepare(
  "INSERT INTO products (name, category, price, stock) VALUES (?, ?, ?, ?)"
);
for (const prod of products) insertProd.run(...prod);

const orders = [
  ["TechCorp Inc", 1, 5, 149.95, "2025-12-01", "delivered"],
  ["StartupXYZ", 2, 2, 299.98, "2025-12-15", "delivered"],
  ["MegaSoft Ltd", 4, 10, 499.90, "2026-01-10", "shipped"],
  ["InnoApps", 7, 20, 399.80, "2026-01-20", "processing"],
  ["DataDriven Co", 5, 1, 199.99, "2026-02-05", "delivered"],
  ["CloudFirst", 3, 3, 239.97, "2026-02-18", "shipped"],
  ["AppBuilder Inc", 8, 5, 449.95, "2026-03-01", "processing"],
  ["SecureNet", 6, 2, 199.98, "2026-03-10", "pending"],
];

const insertOrder = db.prepare(
  "INSERT INTO orders (customer_name, product_id, quantity, total, order_date, status) VALUES (?, ?, ?, ?, ?, ?)"
);
for (const order of orders) insertOrder.run(...order);

fs.writeFileSync(
  path.join(DOCS_DIR, "leave-policy.md"),
  `# Company Leave Policy

## Annual Leave
- All full-time employees are entitled to 24 days of paid annual leave per year.
- Leave accrues at 2 days per month of service.
- Unused leave can carry over up to 5 days into the next year.

## Sick Leave
- Employees receive 12 days of paid sick leave per year.
- A medical certificate is required for sick leave exceeding 3 consecutive days.

## Parental Leave
- Maternity leave: 26 weeks fully paid.
- Paternity leave: 4 weeks fully paid.

## Work From Home
- Employees can work from home up to 3 days per week.
- Managers must approve WFH schedules at the start of each month.
- All-hands meetings on Tuesdays and Thursdays require in-office presence.

## Public Holidays
- The company observes 12 public holidays annually.
- Holiday list is published at the start of each year.
`
);

fs.writeFileSync(
  path.join(DOCS_DIR, "onboarding-guide.md"),
  `# New Employee Onboarding Guide

## Week 1: Getting Started
1. Complete HR paperwork and ID verification.
2. Set up your laptop — IT will provide credentials for email, Slack, and GitHub.
3. Attend the welcome session with your team lead.
4. Review the company handbook in the shared drive.

## Week 2: Training
1. Complete mandatory compliance training modules.
2. Shadow a senior team member for 2 days.
3. Set up your local development environment (see Engineering Wiki).
4. Attend product overview session with the Product team.

## Key Contacts
- IT Support: it-help@company.com
- HR Queries: hr@company.com
- Facilities: facilities@company.com

## Tools We Use
- Slack for communication
- GitHub for code
- Jira for task tracking
- Confluence for documentation
- Figma for design
`
);

fs.writeFileSync(
  path.join(DOCS_DIR, "expense-policy.md"),
  `# Expense Reimbursement Policy

## Eligible Expenses
- Business travel (flights, hotels, ground transport)
- Client meals and entertainment (pre-approved)
- Conference and training fees
- Home office equipment (up to $500/year)

## Submission Process
1. Submit expenses within 30 days of the transaction.
2. Attach original receipts or digital copies.
3. Use the internal expense portal at expenses.company.com.
4. Manager approval is required for amounts over $200.

## Limits
- Domestic travel: up to $250/night for hotels.
- International travel: up to $350/night for hotels.
- Meals: up to $75/person for client dinners.

## Reimbursement Timeline
- Approved expenses are reimbursed within 10 business days.
- Reimbursements appear in your regular payroll deposit.
`
);

console.log("Database seeded with sample data:");
console.log(`  - ${employees.length} employees`);
console.log(`  - ${products.length} products`);
console.log(`  - ${orders.length} orders`);
console.log(`  - 3 company documents`);
console.log("\nDone! You can now run: npm start");
