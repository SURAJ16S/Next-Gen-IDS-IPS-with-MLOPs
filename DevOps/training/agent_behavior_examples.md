# DevOps AI Chat Agent - Behavioral Training Examples

This document provides high-quality few-shot examples for the **DevOps AI Chat Agent** (localhost:5173/agent).
These examples teach correct autonomous decision-making, proactive file inspection, accurate seeding, and proper container networking.

---

## RULE 1: ALWAYS Inspect Before Acting

**WRONG BEHAVIOR (Do NOT do this):**

User: "seed the database with some products"

Agent Response (WRONG):
```
I'll seed the database for you!
<patch file="seed.js">
const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb://localhost:27017'); // ❌ WRONG: localhost doesn't work inside container
async function run() {
  const db = client.db('mydb');
  await db.collection('products').insertMany([
    { name: "Product 1", price: 10.99 } // ❌ WRONG: Made up schema
  ]);
}
run();
</patch>
<exec command="node seed.js" />
```

**CORRECT BEHAVIOR:**

User: "seed the database with some products"

Agent Response (CORRECT):
```
<thought>
I need to first find and read the Product model schema to understand the exact field names and types. I must not guess the schema - I must read it first.
</thought>

Let me first inspect your database schema before generating any seed data.
<exec command="find . -name '*.js' -path '*/models/*' | head -20" />
```

Then, after reading the exec output:
```
I found the Product model at `server/models/Product.js`. Let me read its schema.
<exec command="cat server/models/Product.js" />
```

Then, after seeing the actual schema in the output, generate a matching seed script.

---

## RULE 2: NEVER Use Python Inside the Preview Container

**WRONG BEHAVIOR (Do NOT do this):**

User: "run a script to seed the database"

Agent Response (WRONG):
```
<patch file="seed.py">
import pymongo
client = pymongo.MongoClient("mongodb://localhost:27017/")
</patch>
<exec command="python seed.py" />  ❌ WRONG: Python is NOT installed in this container
```

**CORRECT BEHAVIOR:**

Agent Response (CORRECT):
```
<patch file="seed.js">
const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI || 'mongodb://devops-db-mongodb-JOBID:27017/preview_db';
const client = new MongoClient(uri);
async function run() {
  await client.connect();
  const db = client.db('preview_db');
  await db.collection('products').insertMany([...]);
  await client.close();
}
run().catch(console.error);
</patch>
<exec command="node seed.js" />  ✅ CORRECT: Always use Node.js
```

---

## RULE 3: ALWAYS Use Container Hostnames (Never localhost for Databases)

**WRONG BEHAVIOR:**
```javascript
const uri = 'mongodb://localhost:27017/preview_db'; // ❌ WRONG
const uri = 'mongodb://127.0.0.1:27017/preview_db'; // ❌ WRONG
```

**CORRECT BEHAVIOR:**
```javascript
// Always read environment variable first (already set to correct container hostname):
const uri = process.env.MONGODB_URI || 'mongodb://devops-db-mongodb-JOBID:27017/preview_db'; // ✅
const pgConn = process.env.DATABASE_URL || 'postgresql://postgres@devops-db-postgres-JOBID:5432/preview_db'; // ✅
const mysqlConn = process.env.DB_HOST ? `mysql://root@${process.env.DB_HOST}:3306/preview_db` : 'mysql://root@devops-db-mysql-JOBID:3306/preview_db'; // ✅
```

---

## RULE 4: Read Files Autonomously - Never Ask the User

**WRONG BEHAVIOR:**

User: "show me the package.json"

Agent Response (WRONG):
```
You can view the package.json by navigating to the file in the file explorer. The file should be in your project root directory.
```

**CORRECT BEHAVIOR:**

Agent Response (CORRECT):
```
<exec command="cat package.json" />
```

Or if the file may be in a subfolder:
```
<exec command="find . -name 'package.json' -not -path '*/node_modules/*' | head -5" />
```

---

## RULE 5: Autonomous Multi-Step Decision Making (ReAct Pattern)

**Example: User asks "seed the database accurately by looking at the schema"**

Step 1 — Reason: "I need to find all model files first."
```
<exec command="find . -path '*/models/*.js' -not -path '*/node_modules/*'" />
```

Step 2 — Observe: Got list of model files. Now read schema.
```
<exec command="cat server/models/Product.js" />
```

Step 3 — Observe: Schema shows fields: `name (String, required)`, `price (Number, required)`, `category (String)`, `stock (Number, default: 0)`.

Step 4 — Act: Now generate a matching seed script and ONLY THEN execute it.
```
<patch file="seed.js">
const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI || 'mongodb://devops-db-mongodb-JOBID:27017/preview_db';
const client = new MongoClient(uri);
async function seed() {
  await client.connect();
  const db = client.db('preview_db');
  await db.collection('products').insertMany([
    { name: 'Classic T-Shirt', price: 19.99, category: 'Clothing', stock: 150 },
    { name: 'Slim Jeans', price: 49.99, category: 'Clothing', stock: 80 },
    { name: 'Sneakers', price: 79.99, category: 'Footwear', stock: 45 },
    { name: 'Baseball Cap', price: 24.99, category: 'Accessories', stock: 200 },
    { name: 'Leather Belt', price: 34.99, category: 'Accessories', stock: 60 }
  ]);
  console.log('Seeded 5 products successfully!');
  await client.close();
}
seed().catch(console.error);
</patch>
<exec command="node seed.js" />
```

---

## RULE 6: Handle npm Module Errors Autonomously (Don't Ask the User)

If `node seed.js` fails with `Error: Cannot find module 'mongodb'`, the agent should:

**CORRECT:**
```
I see mongodb is not installed in this container. Let me install it first.
<exec command="npm install mongodb" />
```

Then retry:
```
<exec command="node seed.js" />
```

---

## RULE 7: Use <thought> Blocks to Hide Reasoning

All internal reasoning, planning steps, and chain-of-thought must go inside `<thought>...</thought>` blocks.
Only final user-facing text and executable tags (`<exec>`, `<patch>`) should appear outside.

**WRONG:**
```
First, I will find the model files. Then I will read each one. Then I will create a seed script...
<exec command="find . -path '*/models/*'" />
```

**CORRECT:**
```
<thought>
Plan:
1. Find model files
2. Read schema
3. Generate matching seed
</thought>

Let me inspect your database schema first.
<exec command="find . -path '*/models/*.js' -not -path '*/node_modules/*'" />
```

---

## RULE 8: Correct File Path Resolution for Patches

Always use the **relative path from the workspace root** inside `<patch file="...">` tags.

**WRONG:**
```xml
<patch file="/workspace/server/models/Product.js"> ❌ WRONG - absolute path
<patch file="Product.js"> ❌ WRONG - missing folder
<patch file="./server/models/Product.js"> ❌ WRONG - ./ prefix
```

**CORRECT:**
```xml
<patch file="server/models/Product.js"> ✅ Relative from workspace root
<patch file="client/src/components/ProductCard.jsx"> ✅
<patch file="seed.js"> ✅ For root-level scripts
```

---

## RULE 9: Verify Execution Results Before Reporting Success

After running a seeding or install command, always verify the output.

If the exec output shows:
```
MongoServerError: Authentication failed.
```

Agent should respond:
```
The database connection failed due to authentication. Let me check the environment variables.
<exec command="printenv | grep -i mongo" />
```

And retry with the correct credentials from the env output.

---

## RULE 10: Installing npm Packages Correctly in Containers

**WRONG:**
```
<exec command="npm install -g mongoose" /> ❌ Never use -g (global) in sandboxes
<exec command="pip install mongoose" /> ❌ Python package manager for Node.js package
```

**CORRECT:**
```
<exec command="npm install mongoose" /> ✅
<exec command="npm install mongoose mongoose-seed" /> ✅ Multiple packages at once
```
