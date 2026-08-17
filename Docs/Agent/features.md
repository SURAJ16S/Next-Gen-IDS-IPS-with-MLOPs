# DevOps AI Agent - Features & Capabilities Guide

This guide details the complete feature set implemented in the DevOps AI Agent.

---

## 1. 3-Pane Split IDE Workspace Layout
The DevOps Agent page offers a rich visual layout that brings full IDE capabilities directly to the web dashboard:
- **Responsive Navigation**: Easily switch between deployments using the "Target Deployment" dropdown. The page automatically fetches the active file tree and database structure dynamically.
- **Unified Controls**: Sidebar integration using a `Bot` menu icon links directly to the dashboard shell.

---

## 2. Real-Time Workspace File Explorer & Editor
- **Workspace Navigation Tree**: Fully traversable directory tree structure that ignores bloated system folders (e.g. `node_modules`, `.git`, `dist`, `build`).
- **Active Code Editor Pane**: Clicking on any text file in the workspace fetches its content via API, loading it in the center panel. Users can edit code and hit **Save File** to write modifications back to disk instantly. It is ideal for adjusting environments (`.env`) or tweaking configurations in real-time.

---

## 3. Database Explorer & Seeding Grid
- **Dynamic Connection Detection**: Automatically detects the active database engine (MongoDB, MySQL, PostgreSQL, SQLite) bound to the deployment.
- **Collection Explorer**: Lists tables and collections found in the preview environment.
- **Live DB Grid Tab**: Clicking a collection lists all records in a paginated, formatted tabular grid.
- **Add Document Modal**: Developers can click "Add Document" and submit a custom JSON document. The backend inserts the record into the container database instantly, making it perfect for custom user seeding.

---

## 4. Persistent Multi-Session Conversations
- **Thread Management Dropdown**: Allows developers to maintain multiple separate conversation threads (e.g. "Seeding Products DB", "Fixing Web Port").
- **New Thread Action**: The **"+ New Chat"** button prompts for a title, initializes a database chat thread, and opens a clean discussion board.
- **Context-Aware Completion**: The backend feeds up to 15 messages of conversation history directly into the completions engine, enabling the LLM to remember past commands, code modifications, and user instructions.

---

## 5. Script Execution & Permissions Safety Guard
- **Execution Permission Options**:
  - **Allow this time**: Executes the terminal command once inside the docker preview container and streams the terminal logs into the chat log.
  - **Allow everytime**: Persists permission configuration `'always'` to the deployment document in MongoDB. Future commands execute instantly without confirmation pop-ups.
  - **Never allow**: Persists `'never'` to the database and blocks execution.
- **Script Seeding Utility**: Prompts the LLM to write light JavaScript (`.js`) or Python (`.py`) scripts using standard compilers inside the container. This solves missing dependencies (such as `ts-node`) and keeps database seeding fast and token-efficient.
