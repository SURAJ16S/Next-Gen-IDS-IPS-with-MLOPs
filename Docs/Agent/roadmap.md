# DevOps AI Agent - Future Roadmap

This document outlines the scheduled future roadmap and enhancements planned for the DevOps AI Agent.

---

## Phase 1: Interactive Terminal Emulator & Command Logs
- **Feature Overview**: Integrate an interactive terminal console directly inside the center panel tabs (alongside the Editor and Database tabs).
- **Technical Path**:
  - Leverage `xterm.js` on the React frontend.
  - Implement WebSockets/Socket.io on the Express backend linked directly to container bash streams (`docker exec -it /bin/sh`).
  - Provide a real-time, interactive command-line experience where developers can type commands directly inside the running preview container.

---

## Phase 2: Visual Pipeline & Execution Flow Builder
- **Feature Overview**: Create a visual flowchart showing the step-by-step pipeline stages (Source ZIP extraction -> Deprecated package patch -> Docker build -> Environment binding -> Health checks).
- **Technical Path**:
  - Integrate `React Flow` to draw a network topology graph.
  - Animate nodes dynamically with green, orange, or red halos matching compilation outcomes in real-time.
  - Allow developers to click on a stage node to inspect its specific build logs.

---

## Phase 3: Advanced Smart Seeding Engine
- **Feature Overview**: Expand the database seeding engine to automatically infer database schemas and suggest customized seed mock datasets.
- **Technical Path**:
  - On pipeline initialization, scan source files for Mongoose/Sequelize schemas, or run introspective queries (`DESCRIBE tables` or `mongosh schema analyzer`).
  - Send schema models to the LLM to auto-generate Python mock generation scripts (using libraries like `Faker`).
  - Provide a one-click dashboard button to pre-fill collections with 100+ contextually accurate rows.

---

## Phase 4: Autonomic Self-Healing Rules Engine
- **Feature Overview**: Define customizable automation rules that govern how the agent handles compilation and deploy failures.
- **Technical Path**:
  - Add a **Rules Settings** section where users can toggling self-healing behavior:
    - *Auto-fix Typescript Compilation Errors*: Enabled/Disabled.
    - *Auto-rebuild on Env Variable Edits*: Enabled/Disabled.
    - *Max Fix Attempts*: Counter limits (e.g. stop after 5 unsuccessful compile patches to prevent infinite loops).
