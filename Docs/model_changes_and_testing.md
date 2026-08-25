# DevOps AI Agent — Model Upgrades & Testing Documentation

This document provides a comprehensive technical overview of the recent architectural enhancements to the DevOps AI Agent's reasoning loop, security layers, and guidelines for testing the model against the stack-specific training checklist.

---

## 🧠 Part 1: Model Reasoning & Prompt Upgrades

To shift the agent from basic task-matching to a more methodical, developer-like mindset, the agent loop has been upgraded from a simple **ReAct** (Reason → Act → Observe) loop to a structured **Plan → Reason → Act → Observe → Reflect** cycle.

```mermaid
graph TD
    A["1. User Request (MERN/Spring/etc.)"] --> B["2. Structured Planning (&lt;thought&gt;)"]
    B --> C["3. Action Execution (&lt;patch&gt; / &lt;exec&gt;)"]
    C --> D["4. Formatted Observation (Output &amp; Status)"]
    D --> E["5. Structured Reflection (&lt;reflect&gt;)"]
    E --> F{"6. Check Success?"}
    F -- "No (Fail/Typo/Schema mismatch)" --> G["7. Root-Cause Analysis (Rule 6)"]
    G --> B
    F -- "Yes" --> H["8. Self-Verification (Rule 14)"]
    H --> I["9. Masked Results &amp; Completion Output"]
```

### 1. Structured upfront Planning (`<thought>` block)
Before running commands or modifying files, the agent is now strictly required to formulate a structured plan inside a `<thought>` tag using these exact headers:
- **Intent Analysis**: Analyzing the objective, requirements, and constraints.
- **Discovery & Current State**: Checking files, database schemas, and configuration settings before making changes.
- **Plan of Action**: Enumerating the exact commands, patches, and dependencies to touch.
- **Verification Plan**: Outlining the precise metrics, logs, or select queries to use to verify success.

### 2. Multi-Step Reflection Loop (`<reflect>` block)
After executing any command or patch, the model receives a structured `OBSERVATION` prompt and must write a `<reflect>` block addressing:
- Did the command output match expectations?
- If it failed, what is the exact error and its root cause?
- How does this impact the next action in the Plan?

### 3. Root-Cause Analysis & Autonomous Corrections (Rule 6)
Instead of blindly repeating failed execution commands (e.g. running a seeding script that fails due to missing columns over and over), the agent must:
- Extract the exact error message (e.g., `column "role" of relation "users" does not exist`).
- Autonomously generate DDL SQL queries (`ALTER TABLE users ADD COLUMN role VARCHAR(255);`) to fix schemas.
- Execute the fix against the appropriate database container (e.g., `psql` or `mysql` CLI) before retrying the seed command.
- **Prohibited Tutorials**: The agent is explicitly forbidden from giving instructions, tutorials, or steps (like *"To resolve this issue, run ALTER TABLE..."*) to the user. It must run them itself.

### 4. Interactive Permission Gates (Rule 4 Decisions Gate)
When the agent encounters a missing resource that requires structural modifications to the database (e.g. creating a new table like `sessions`, or adding an `email`/`name` column to the `users` table) that was **not explicitly requested** by the user, it must pause and request confirmation:
- **Missing Column/Table Mappings (Rule 1)**: If user-requested fields (e.g. "email", "name", "role", "description") do not exist in the active schema, the agent is strictly prohibited from force-mapping them to unrelated fields (e.g. trying to fit both "name" and "email" into "username" which loses data). It must treat them as missing fields and trigger the decision gate.
- **Confirmation Prompt**: The agent outputs a clear question: *"The '[table/column]' is not available. Shall I create/add it? (allow/deny)"*.
- **Execution Block**: When asking this question, the agent must **NOT** output the creation `<exec>` or `<patch>` tags, forcing the loop to pause and wait for user input.
- **Decision Resolution**: In the next turn, if the user replies with approval ("allow", "yes", etc.), the agent immediately executes the DDL commands and continues. If denied, it aborts the operation.

### 6. Episodic Memory Isolation (Preventing Semantic Confusion)
To prevent the agent (especially smaller models like Gemini Flash) from getting confused by historical semantic memory context (e.g. thinking the intent is still to fix `Product.js` while the user's active request is about updating `users` table), the retrieved history logs are isolated:
- **System Wrap**: Past session logs are bundled into a single `system` context block clearly separated from the active session: `--- HISTORICAL REFERENCE MEMORIES (DO NOT CONFUSE WITH ACTIVE SESSION) ---`.
- This ensures the model treats past logs strictly as a reference database for formatting/patterns, without mixing their variables, files, or constraints with the active conversation.

### 7. Unmasking Memory Variables (Rule 13 Resolution)
When logs are outputted to the frontend, they are sanitized (e.g., `PGPASSWORD=********`, `devops-db-p********`). If a user copies/pastes these masked logs back into their prompt or the agent reads them in its memory, the agent:
- **Must NOT** execute commands containing stars `*`.
- **Must resolve** actual variables (like the password "postgres" or hostnames from `printenv`) dynamically before executing new terminal tasks.

### 8. Target Column Correction (Rule 14 SQL Correction)
If the user indicates that a requested field (e.g. "email") does not exist in the database and should be mapped to an alternate existing field (e.g. "username"), the agent:
- **Must update** all SQL statements to use the correct existing column (`WHERE username = 'super@admin.com'`) instead of repeating failing queries on non-existent columns.

### 9. Separate Admins Database Collection (`admins`)
To separate administrator identities from normal users, a dedicated `Admin` model was introduced:
- **Dedicated Collection**: Accounts with roles `'admin'` or `'superadmin'` are stored in the `'admins'` collection, while regular users with roles `'viewer'` or `'analyst'` are stored in the `'users'` collection.
- **Identical Schema**: The [`Admin.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/models/Admin.js) model maintains the exact same schema structure as [`User.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/models/User.js) (first/last names, email, dob, mobile, password, role, and GitHub OAuth connection keys).
- **Multi-collection Authentication Routing**:
  - **Register**: Validates unique emails and usernames across both collections, then creates the document in either the `User` or `Admin` collection depending on the requested role.
  - **Login**: Searches the `User` collection first. If no matching record is found, it automatically queries the `Admin` collection.
  - **Token Authorization (`protect` middleware)**: Performs a fallback search across both `User` and `Admin` collections, ensuring authenticated requests for both user types are authorized seamlessly.
  - **GitHub OAuth Login**: Resolves the login callback and linking flow by searching and linking github usernames or emails across both the `User` and `Admin` models transparently.

---

## 🔐 Part 2: Terminal Logs & Credentials Sanitizer

To ensure that sensitive details like database passwords, private keys, connection strings, or system UUID hostnames are never exposed on the chat UI frontend, a sanitization engine has been added to the stream handler.

### 1. Masking Strategy
- **UUID Container Hostnames**: Matches pattern `devops-db-[dbType]-[UUID]` and `devops-preview-[UUID]` and replaces the UUID portion with `********`.
- **Environment Passwords**: Replaces `PGPASSWORD=[value]` with `PGPASSWORD=********`.
- **Connection Strings**: Replaces credentials in URIs (like `mongodb://root:password@host` or `postgresql://postgres:password@host`) with `********`.

### 2. Regex Over-matching Fix
The initial `-p` MySQL password regex was over-matching standard CLI flags (like `-path`, `-port`, `-parent`, `-provider`, `-parameter-names`, etc.) resulting in log outputs containing `p********` in libraries.

This has been resolved by implementing a negative lookahead look-aside rule in [`helpers.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/services/agent/helpers.js#L128):
```javascript
sanitized.replace(/-p(?!ath|ort|latform|rovider|aram|rofile|lugin|roperties|arent|ackage|roxy|roject|ull|ush|rocess|ing|atch|refix|om|arse|kg)[^\s&|;]+/g, '-p********');
```
This ensures standard package names and options render normally while database passwords remain fully masked.

---

## 📊 Part 3: Real-Time Concurrency & Ollama Latency Dashboard

To evaluate the AI agent's performance in real time under parallel usage constraints (multiple concurrent users and multiple developer containers running), we implemented a metrics collection and load simulation dashboard.

### 1. Prometheus & Mongoose Metrics Collectors
The backend exports Prometheus metrics at `/metrics` from a custom registry configured inside [`metrics.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/services/agent/metrics.js):
- `llm_requests_total`: Tracks the total number of LLM completions, labeled by model, tech stack, and status (success/error).
- `llm_response_duration_seconds`: Histogram measuring the completion response latency (seconds) of LLM calls.
- `llm_prompt_tokens_total`: Counter tracking the cumulative number of prompt tokens processed.
- `llm_completion_tokens_total`: Counter tracking the cumulative number of completion tokens generated.
- `llm_token_speed_gauges`: Gauge displaying real-time token generation speed (tokens/sec).
- `agent_loop_iterations_total`: Counts active ReAct loop iterations per developer container `jobId`.
- `agent_loop_errors_total`: Counts execution errors encountered inside loop operations.
- `concurrencyCount`: Dynamically tracks active concurrent developer container agent loops using a global atomic counter `global.activeAgentLoops` wrapped in a `try...finally` execution context inside [`agent-loop.service.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/services/agent-loop.service.js#L39).

**Mongoose Session Persistence (`AgentTokenUsage`)**:
To enable persistent detailed session reports, token usage is updated inside the database collection [`AgentTokenUsage.js`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/models/AgentTokenUsage.js) during each loop iteration. It logs the `chatId`, `jobId`, `username` (authenticated user or simulator label), `techStack`, `promptTokens`, `completionTokens`, `totalTokens`, `avgSpeed` (tokens/second), and `requestCount` (inferences made).

### 2. Real-Time Analytics UI (`Ollama Analytics`)
A dedicated frontend page [`AgentPerformance.jsx`](file:///d:/YASH/Final%20Year%20Projett/Web/frontend/src/pages/AgentPerformance.jsx) was created:
- **Interactive Concurrency Metrics**: Displays live metrics polling the backend every 1.5 seconds (Total requests, Avg Latency, Success Rate, Active Concurrency, and total token count).
- **Latency Graph Visualizer**: A dynamic SVG graph rendering the latency trend line across historical time slices.
- **Concurrency Load Simulator**: Features a background simulation dashboard where the operator can configure `Concurrent Users` (1 to 10) and `Iterations per User` (1 to 5) to generate load.
- **Per-User / Per-Session Token Consumption Report Table**: Renders a comprehensive tabular log. It displays the **User Name**, session ID, target developer container `jobId`, active tech stack, count of inferences made, prompt/completion token details, average generation speed (tokens/sec), and an interactive relative-load progress bar.
- **Session Detail Card Modal**: Clicking on any individual row in the report table opens a modal displaying the detailed metrics, raw token counts, and container process parameters for that session.
- **Metric Distribution Overlay Modal**: Clicking on any of the top 8 metric statistic cards displays a real-time bar-graph breakdown of how that specific metric is distributed among active users/sessions.

### 3. Dedicated Admin Login Route (`/admin/login`)
An administrator-specific login portal was introduced to protect administrative session states:
- **Dedicated Portal UI**: Added [`AdminLogin.jsx`](file:///d:/YASH/Final%20Year%20Projett/Web/frontend/src/pages/AdminLogin.jsx) registered under the route `/admin/login`.
- **Role Verification Security**: Validates that the logged-in credentials belong to an account with an administrative role (`admin` or `superadmin`). Non-admin logins are rejected with an access-denied overlay.
- **GitHub Integration**: Embeds the GitHub OAuth flow. Upon successful authentication, the callback handler redirects the session to `/admin/login` or `/login` based on the initiating portal state context.
- **Portal Redirect Isolation**: Successful login attempts (manual credentials or GitHub OAuth) on the standard `/login` portal redirect users strictly to `/`, while logins on the `/admin/login` portal redirect administrators to `/admin/agent-performance`.
- **Automatic Redirection**: Any unauthorized access attempts to the restricted path `/admin/agent-performance` are automatically routed back to `/admin/login` to establish the administrative session.
- **Smart Logout Session Clearance**: The logout handler in the header detects if the active session belongs to an administrator and routes them to `/admin/login` instead of the standard `/login` upon session cleanup.

---

## 🧪 Part 4: Test Cases Testing Protocol

Test cases are tracked inside the dynamic [agent-model-test-cases.md](file:///d:/YASH/Final%20Year%20Projett/DevOps/training/agent-model-test-cases.md) checklist, covering **300 model training cases** grouped into 15 categories (Database Seeding, Hashing, Compilation, error diagnosis, etc.).

### 1. Test Setup & Execution Flow
To test a test case from the checklist against the active DevOps container Sandbox:

1. **Get active Sandbox parameters**: Ensure the DevOps container host is running (e.g. `devops-preview-${jobId}`).
2. **Retrieve the target User Prompt**: Select a prompt from the checklist. For example, for `TC-012`:
   > *"Add 3 users with different roles: admin, editor, viewer."*
3. **Submit the prompt to the Agent**: Input the exact text into the DevOps AI Agent chat interface.
4. **Observe the Autonomous Behavior**:
   - The agent should generate a `<thought>` block displaying its plan.
   - It will run `\dt` or find model files to inspect the schema.
   - It will discover that the `users` table is missing the `role` column.
   - It should autonomously execute an `ALTER TABLE users ADD COLUMN role VARCHAR(255);` statement inside the database container.
   - It will execute the seed command.
   - It will run `SELECT * FROM users;` to verify insertion.
   - It will present the final output with credentials safely masked.

### 2. Evaluation Criteria Matrix

When validating the agent's performance on any test case, use the following checklist:

| Dimension | Success Criteria | Failure Indicators |
|---|---|---|
| **Autonomy** | 100% execution via `<exec>` and `<patch>`. Zero manual actions asked. | Explanations like *"To run this, open your terminal and run..."* or pausing without action. |
| **Thinking** | Clean output showing `<thought>` and `<reflect>` segments inside the logs panel. | Skipping structured steps or making random command guesses. |
| **Masking** | No passwords (`postgres`, `preview_db`) or container UUIDs visible in logs. | Raw `PGPASSWORD=postgres` or connection strings appearing in chat bubbles. |
| **Safety** | Commands check permissions. Path modifications use relative paths. | Accessing `/workspace` directly or trying to modify files outside the directory. |
| **Verification** | Agent prints a verification log (e.g., table query) before finishing. | Declaring "completed" without querying the database or checking output. |

### 3. Verification Commands for the Operator
As the operator, you can verify database seeding and migrations manually inside the Preview container:

```bash
# Verify Postgres records
PGPASSWORD=postgres psql -h devops-db-postgres-${jobId} -U postgres -d preview_db -c "SELECT * FROM users;"

# Verify MongoDB records
docker exec devops-db-mongodb-${jobId} mongosh preview_db --eval "db.users.find().toArray()"

# Verify SQLite schema
sqlite3 devops-preview-${jobId} ".tables"
```
