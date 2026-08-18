# DevOps AI Agent - Reasoning & Decision Quality Guide

This document contains aligned reasoning patterns for the DevOps AI Chat Agent to make correct autonomous decisions.

---

## Situation 1: Schema Inference for Seeding

When the user says "seed the data", "populate the database", or similar without specifying a schema, the agent MUST:

1. **Never assume schema fields.** Do not generate seed data based on common field names like `name`, `description`, `price` without first confirming they exist in the actual code.
2. **Run a search command to find model/entity files:**
   ```
   <exec command="find . -path '*/models/*.js' -not -path '*/node_modules/*' -o -path '*/Models/*.cs' -o -path '*/entities/*.java'" />
   ```
3. **Read each model file using cat:**
   ```
   <exec command="cat server/models/Product.js" />
   ```
4. **Parse the schema fields from the output:**
   - For Mongoose/Node: Look for `{ type: String }`, `{ type: Number }`, `required: true` decorators.
   - For Prisma: Look for `model Product { id Int @id ... }`.
   - For Django: Look for `models.CharField`, `models.IntegerField`, etc.
5. **Generate seed data that EXACTLY matches the observed fields and types.**

---

## Situation 2: Connection String Resolution

Database connection strings inside the container are NEVER on localhost. The databases run in separate containers on the same Docker network.

The correct pattern is:
```javascript
// Always prefer environment variables (pre-configured by DevOps pipeline):
const mongoUri = process.env.MONGODB_URI 
  || process.env.MONGO_URL 
  || `mongodb://devops-db-mongodb-${JOBID}:27017/preview_db`;

const pgUri = process.env.DATABASE_URL 
  || process.env.POSTGRES_URL
  || `postgresql://postgres@devops-db-postgres-${JOBID}:5432/preview_db`;

const mysqlUri = `mysql://root@${process.env.DB_HOST || `devops-db-mysql-${JOBID}`}:3306/preview_db`;
```

If unsure about the JOBID, use:
```
<exec command="printenv | grep -i 'mongo\|postgres\|mysql\|db_host\|database'" />
```

---

## Situation 3: Handling Exec Output Errors

When an exec command fails, the agent should analyze the error and retry autonomously.

**Error: `command not found: ts-node`**
→ Use `node` to run `.js` files directly. Rewrite any TypeScript seed scripts to plain `.js`.

**Error: `Cannot find module 'mongoose'`**
→ Run `<exec command="npm install mongoose" />` and then retry.

**Error: `ECONNREFUSED 127.0.0.1:27017`**
→ The script is using `localhost`. Rewrite the connection string to use container hostname.

**Error: `MongoServerError: ...`**
→ Check env variables: `<exec command="printenv | grep MONGO" />`

**Error: `sh: python: not found`** 
→ Rewrite the script in Node.js (JavaScript). Python is not available in this container.

---

## Situation 4: Complex Project Structure Navigation

For monorepo or multi-folder projects, always discover structure first:

```
<exec command="ls -la" />
```

Then if `server/` and `client/` folders exist, check the correct one:
```
<exec command="ls server/" />
<exec command="cat server/package.json" />
```

For Spring Boot: look for `src/main/java`, for Laravel: `app/Models`, for Django: `*/models.py`.

---

## Situation 5: When Asked to Diagnose a Problem

When the user says "it's not working", "there's an error", or "fix this", the agent should:

1. Look at running processes:
   ```
   <exec command="ls logs/ 2>/dev/null || find . -name '*.log' | head -5" />
   ```
2. Check the main entry file and look for syntax errors:
   ```
   <exec command="node --check server/index.js 2>&1 || node --check server/server.js 2>&1" />
   ```
3. Read error-relevant files based on the reported issue.
4. Propose a targeted patch to fix the specific error.

---

## Situation 6: Code Modification Best Practices

When modifying existing files:
1. Read the file FIRST before patching: `<exec command="cat server/routes/products.js" />`
2. Only change the specific part that needs modification.
3. Include the COMPLETE file content in the `<patch>` tag (not just changed lines).
4. Never break existing features — preserve all existing routes and logic.

---

## Situation 7: Autonomous Dependency Resolution

When a task requires a library that may not be installed:
1. Check if it exists: `<exec command="ls node_modules | grep mongoose" />`
2. If not present: `<exec command="npm install mongoose" />`
3. Proceed with the task.

Do not ask the user to install packages manually.

---

## Common Correct Response Patterns

### Pattern: Create a file with content
```
<patch file="path/to/file.ext">
file content here
</patch>
```

### Pattern: Run a JS script
```
<exec command="node scriptname.js" />
```

### Pattern: Find a file
```
<exec command="find . -name 'filename.ext' -not -path '*/node_modules/*'" />
```

### Pattern: Read a file
```
<exec command="cat path/to/file.ext" />
```

### Pattern: Check environment variables
```
<exec command="printenv | grep -i keyword" />
```

### Pattern: Install npm package
```
<exec command="npm install packagename" />
```

### Pattern: Verify a script exists and run it
```
<exec command="ls package.json && node -e \"require('./package.json')\" && node seed.js" />
```
