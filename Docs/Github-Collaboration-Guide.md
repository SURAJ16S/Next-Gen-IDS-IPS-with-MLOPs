# GitHub Collaborator Permissions & Isolation Guide

**Date:** 2026-08-18  
**Scope:** GitHub-linked Deployments & Sandbox Security  
**Author:** DevOps Platform Architecture Team

---

## 1. Overview of Scoped Abstraction

To ensure data security and multi-user safety in the DevOps IDS-IPS Sandbox platform, **strict role-free data isolation** is enforced. 

* By default, a deployment is only visible to and controllable by the user who built it.
* A user cannot view, build, run queries, or chat with AI agents of another user's deployment.
* For team workflows, access is extended to **GitHub Collaborators** based on the repository linked to the build.

---

## 2. Onboarding Workflow: Adding & Syncing Collaborators

To add a collaborator and share deployment privileges, follow these steps:

### Step 1: Grant Access on GitHub
1. Navigate to the repository settings page on GitHub for your project (e.g. `https://github.com/owner/repo/settings/access`).
2. Click **Add people** and invite the collaborator's GitHub account (e.g., `borudeyash1`).

### Step 2: Log into the IDS-IPS Platform
1. The invited collaborator must log into the IDS-IPS system using **the same GitHub account** they use on GitHub. This links their platform account ID with their GitHub username.

### Step 3: Synchronize Collaborators List
1. As the Owner/Author of the build, go to the deployment dashboard on the `/devops` page.
2. Select the GitHub-linked deployment.
3. In the **👥 GitHub Collaborator Permissions** card, click the **Sync** button.
4. The backend queries GitHub's REST API `/repos/{owner}/{repo}/collaborators` using the owner's OAuth token and synchronizes the list of usernames allowed to access this deployment.

---

## 3. Granular Privilege Tweaks by the Author

Once synced, the author can adjust the permissions of collaborators dynamically. The platform provides **five granular permission toggles**:

| Toggle | Description | UI Enforcement | Backend Guardrail |
|---|---|---|---|
| **👁️ View Sandbox (Visibility)** | Allows collaborators to see the sandbox on their `/devops` and `/agent` pages. | Hidden/Filtered from List | Query filters matching collaborator username |
| **▶️ Start / Stop Sandbox** | Allows collaborators to boot up or stop the Docker preview container. | Disabled "Start/Stop Sandbox" buttons | Rejects start/stop requests in `access.middleware.js` |
| **🔌 Edit Sandbox Port** | Allows collaborators to assign a new preview port. | Disabled "Edit Port" forms | Rejects port changes in `access.middleware.js` |
| **🗑️ Delete Deployment** | Allows collaborators to permanently wipe the deployment record and clean files. | Disabled "Delete" buttons | Rejects deletion requests in `access.middleware.js` |
| **🤖 Chat with AI Agent** | Allows collaborators to interact with the DevOps AI Agent on the `/agent` page. | Chat input locked with warning | Rejects message ingestion in `access.middleware.js` |

---

## 4. Immediate Reflection of Changes

Permissions are designed with a **zero-delay synchronization flow**:

1. **State Update:** When the author toggles a checkbox in the UI, a `PATCH` request is sent to `/api/devops/deployments/:id/permissions` and saved in MongoDB.
2. **Frontend UI Reflection:** The UI reactively updates the component state. Collaborators visiting the dashboard will immediately see options disabled, cursor styled to `not-allowed`, and custom tooltips indicating `"Access restricted by owner"`.
3. **Backend Middleware Enforcement:** Even if a malicious user tries to bypass the UI using curl/Postman, the backend routing middleware (`access.middleware.js`) intercepts the request:
   ```javascript
   // Checks permissions in real-time
   if (!getBuildAccess(deployment, req.user)) {
     return res.status(403).json({ message: "Access restricted by owner" });
   }
   ```
