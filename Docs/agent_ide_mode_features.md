# Agent IDE Mode: Architecture and Feature Updates

This document outlines the changes, architectural decisions, and new features built into the `/agent` page (`Agent.jsx`) to support the **Full IDE Mode**.

## Overview
The goal of the IDE mode was to provide a developer-centric, fullscreen workspace where users can seamlessly interact with the AI agent while retaining full context of their codebase, editor, and terminal output. 

## Key Features Implemented

### 1. Full IDE View Architecture (`FullIDEView` Component)
The `FullIDEView` component was abstracted to handle the fullscreen rendering of the workspace. It manages its own complex state for editor panes and terminal windows, while inheriting core business logic (like chat history and theme preferences) via props from the parent `Agent` component.

- **Split-Pane Layout**: The UI is divided into a file explorer sidebar, a central editor pane, and a right-side chat interface.
- **Bottom Panel Tabs**: Includes toggles for **Terminal**, **Database Shell**, and **Problems** to mimic standard IDE environments.

### 2. Editor and Theme Synchronization
- **Monaco Editor Integration**: Embedded the `@monaco-editor/react` library to provide a native VS Code-like coding experience.
- **Dynamic Theming**: The IDE automatically detects the active theme (`ideTheme`) and synchronizes the editor and UI backgrounds.
  - Fixes were implemented to ensure text remains perfectly legible by dynamically applying light text on dark themes and dark text on light themes.
  - The `themeStyles` object dynamically calculates border colors, active backgrounds, and text shades across the file explorer and chat bubbles.

### 3. File Explorer & Iconography
- A custom `getFileIcon` utility function was built to support comprehensive file extensions.
- Extended support for DevOp/Cloud specific files including:
  - `Dockerfile`, `.dockerignore`
  - Kubernetes/Ansible `.yaml`, `.yml`
  - Terraform `.tf`, `.tfvars`
  - Scripts `.sh`, `.bat`, `.ps1`
  - Standard development files (`.js`, `.jsx`, `.ts`, `.py`, `.md`)

### 4. Advanced Settings Panel (`IDESettingsPanel`)
A completely new "Agent" tab was built into the settings modal to manage local execution environments and security:
- **Agent Security Mode**: Options for *Full Access*, *Sandboxed*, and *Strict* mode.
- **Terminal Auto-Execution**: Toggles for whether the agent requires manual review before executing shell commands.
- **Shell Integration**: Allow the agent to utilize the IDE's built-in shell for continuous interactive processes.

### 5. Chat Interaction Parity (Rollback & Undo)
To ensure users don't lose functionality when switching from the standard chat mode to IDE mode, we ported essential interaction features into the `FullIDEView` message renderer:
- **Patch Viewer & Rollback**: Users can inspect file modifications proposed by the agent inside a dedicated patch UI box and click the `Rollback` button to instantly revert those changes.
- **Query Undo**: An inline `<RotateCcw />` Revert icon was added next to user query bubbles to trigger the `undoChatMessages` API, cleanly resetting the chat state to that specific point in time.

## Future Considerations
- Add deeper integration between the agent's context window and the currently active Monaco editor selection.
- Persist the user's layout preferences (like side-panel width and terminal height) to `localStorage`.
