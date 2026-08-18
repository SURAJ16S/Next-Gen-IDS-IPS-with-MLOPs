# DevOps Export, Remediation & Architecture Adaptability Guide

This guide documents the export mechanisms, security scanning, auto-remediation, and stack-specific branch publication features of the DevOps Sandbox platform.

---

## 1. GitHub New Branch Export

The platform allows developers to publish their compiled, validated build workspaces directly back to GitHub as a **new branch** without modifying any existing branches in the repository.

### Technical Workflow
1. **Branch Ref Creation:**
   * The platform fetches the latest commit SHA of the repository's default branch (e.g. `main` or `master`) via `GET /repos/{owner}/{repo}/git/ref/heads/{default_branch}`.
   * A new branch reference is created using the Git Database API: `POST /repos/{owner}/{repo}/git/refs`.
   * **Collision Handling:** If the requested branch name already exists, the platform automatically appends a timestamp (`-timestamp`) to ensure uniqueness.
2. **Sequential File Push:**
   * To prevent triggering GitHub's secondary rate limits or abuse detection systems, files are pushed sequentially via individual `PUT /repos/{owner}/{repo}/contents/{path}` API calls.
   * If a file already exists on the default branch and its base64 content is identical to the build workspace, it is automatically skipped to save API calls.
3. **3-Publish Limit & History tracking:**
   * A single build is limited to a **maximum of 3 branch exports** to prevent API abuse and storage clutter.
   * Every branch publish logs metadata to the `Deployment` record in MongoDB:
     ```javascript
     publishedBranches: [
       {
         branchName: String,
         branchUrl: String,
         repoFullName: String,
         publishedAt: Date
       }
     ]
     ```
   * The DevOps UI displays the history of links under **"Previously Published Branches (X/3 max)"** persisting across page reloads.

---

## 2. Dynamic Architecture Adaptability & Exclusions

When exporting to GitHub, it is critical to avoid committing dependencies, binary compilation artifacts, and virtual environments. The platform features an **architecture-aware ignoring mechanism**.

### Stack-Specific Exclusions Map
The system automatically determines exclusions and informs the user dynamically in the UI based on the detected tech stack:

| Detected Stack | Dynamic Exclusions / Ignored Folders |
| :--- | :--- |
| **Python** (Flask, Django, FastAPI) | `.env`, `.git`, `node_modules`, `.venv`, `venv`, `env`, `__pycache__`, `.pytest_cache` |
| **Java** (Spring Boot, Quarkus) | `.env`, `.git`, `node_modules`, `target`, `build`, `.gradle`, `bin`, `out` |
| **.NET / C#** (Blazor, WebAPI) | `.env`, `.git`, `node_modules`, `bin`, `obj` |
| **Rust** (Cargo apps) | `.env`, `.git`, `node_modules`, `target` |
| **Ruby** (Rails, Sinatra) | `.env`, `.git`, `node_modules`, `.bundle`, `vendor/bundle` |
| **PHP** (Symfony, Laravel) | `.env`, `.git`, `node_modules`, `vendor`, `composer.lock` |
| **JS / Node** (React, MERN, Next.js, Nuxt) | `.env`, `.git`, `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `out`, `.cache` |

### Recursive File System Crawler (`walk`)
- **Gitignore Integration:** The crawler parses local `.gitignore` files inside the build workspace dynamically, translating standard globs into regular expressions to skip developer-ignored files.
- **EACCES Safety Guard:** Operating system symlinks or docker virtualenv files (like `.venv/bin/python`) may throw permission errors during traversal. The platform's file system walker wraps `fs.readdirSync` and `fs.statSync` in `try/catch` statements to log warnings and skip locked files instead of crashing the pipeline.

---

## 3. Secure Credentials Scan & Remediated PDF Export

To prevent API keys, database credentials, and secret tokens from leaking to public repositories, the platform incorporates pre-build scanning, auto-remediation, and encrypted key export.

### Auto-Remediation Flow
1. **Static Analysis:** Before compilation, `scanDirectoryForCredentials` checks all source code files against entropy tables and regex patterns for credentials.
2. **Extraction:** If found, the credentials are stripped from the source files (e.g. `app.py` or `config.js`) and replaced with environment variables: `os.environ.get('KEY')` or `process.env.KEY`.
3. **Local Ingestion:** The raw values are appended to the build workspace's local `.env` file.
4. **Git Isolation:** `.env` is strictly blocked from the GitHub branch export.

### Secure Env PDF Generation
Because the credentials are now isolated inside `.env` on the container host, developers need a secure way to access them.
* **Encryption:** The backend compiles a PDF containing all active environment variables, encrypted with standard PDF permissions using a secure password: `DevOps-Env-{jobId_prefix}`.
* **Owner-Only Restrictiveness:** Only the deployment owner (the author of the build) has the permission to view and download the **Secure Env PDF** button.

---

## 4. Clean ZIP Export

If developers want to run their sandboxed applications locally, they can download a zipped package directly from the DevOps Dashboard.
- **Dependency stripping:** Heavy dependency directories (`node_modules`, `.venv`, etc.) are stripped from the downloadable ZIP to reduce bundle size and prevent host environment contamination.
- **Portability:** The package contains the remediated code, configuration parameters, and supply-chain scan results, allowing developers to set up their databases and run the container locally with a single command.
