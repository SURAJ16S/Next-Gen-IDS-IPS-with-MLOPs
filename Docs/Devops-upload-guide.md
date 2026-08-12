# DevOps Ingestion Guide: How to Package & Upload Applications

This document provides clear, step-by-step instructions for developers to package and upload their applications through the Next-Gen IDS/IPS DevOps Sandbox dashboard. 

---

## 1. How the Pipeline Works

When you upload a ZIP archive of your source code:
1. **Extraction:** The backend extracts the files into an isolated workspace directory.
2. **Detection:** The system automatically scans the files to detect the tech stack (MERN, Spring Boot, Django, Rust, etc.).
3. **Compilation:** An isolated Docker container is started matching the tech stack, and the application's dependencies are installed and compiled (e.g. `npm run build` or `mvn package`).
4. **Security Gating:** Sidecar containers running **Semgrep SAST** and **OSV Dependency Scanner** audit the workspace.
5. **Artifact Packaging:** The completed build outputs are packaged back into a downloadable ZIP archive.

---

## 2. Step-by-Step Instructions

### Step 1: Clean Your Codebase
Before creating a ZIP archive, ensure you are not uploading unnecessary cache or runtime folders. Although the pipeline filter automatically discards these folders, removing them locally makes the ZIP upload significantly faster:
* Delete `node_modules/` (Node.js/MERN)
* Delete `target/` and `build/` (Java/Spring)
* Delete `.git/` (Git repository files)
* Delete `dist/` or `.next/` (Previous build outputs)

### Step 2: Package the Files (Zipping Correctly)
The manifest configuration files (e.g., `package.json`, `pom.xml`, `requirements.txt`, or `Cargo.toml`) must be positioned at the **root** of the ZIP archive.

#### ⛔ Incorrect Zip Structure (Nested Root):
If you zip the enclosing folder directly, the structure becomes nested:
```text
my-project.zip
└── mern-app/
    ├── package.json   <-- Nesting inside a folder makes detection harder
    └── src/
```

####  Correct Zip Structure (Root Level):
Navigate *inside* your project directory, select the files directly, and compress them:
```text
my-project.zip
├── package.json       <-- Positioned at the absolute root of the ZIP
├── src/
└── Dockerfile
```

* **Windows Command Line (PowerShell):**
  ```powershell
  Compress-Archive -Path .\* -DestinationPath ..\my-project.zip
  ```
* **macOS / Linux Command Line:**
  ```bash
  zip -r ../my-project.zip . -x "node_modules/*" "target/*" ".git/*"
  ```

### Step 3: Upload via Dashboard
1. Navigate to the **DevOps** dashboard on the React frontend.
2. Enter an optional **Project Name** (defaults to the zip name if left blank).
3. Click the **ZIP Package** field, choose your `.zip` archive, and hit **Start Pipeline Execution**.
4. Monitor the live log stream in the green-on-black terminal window. Once the build completes successfully, click **Get ZIP** to download the clean, built artifact!

---

## 3. DOs and DON'Ts Checklist

### DO:
* **DO** ensure Docker Desktop or the Docker daemon is active on the host machine before initiating a run.
* **DO** check the real-time console log stream for detailed compilers/warnings output if your build status switches to `failed`.
* **DO** verify that your dependencies are defined correctly in your manifest files (`package.json`, `pom.xml`, etc.).
* **DO** clean up your local cache directories (`node_modules`) before zipping to save upload bandwidth.

### DON'T:
* **DON'T** include pre-built binaries or compiled assets inside your zip. Let the container build them fresh to guarantee target runtime compatibility.
* **DON'T** zip the parent directory. Select the files inside the folder and compress them.
* **DON'T** try to interact with the temporary build workspace directory (`DevOps/builds/<jobId>`) on the host machine; it is completely ephemeral and is deleted automatically after compilation.
* **DON'T** upload files larger than `50MB` (enforced by the backend upload gateway).

---

## 4. Troubleshooting Common Issues

### 1. Error: `EEXIST: file already exists, mkdir ...`
* **Cause:** The unzipper tried to write a directory entry as a file stream.
* **Solution:** This has been resolved in the latest backend update. Ensure your zip file contains valid file paths and try uploading again.

### 2. Status immediately goes to `FAILED` with no logs
* **Cause:** The backend was unable to establish a connection to your local Docker socket/engine.
* **Solution:** Start your local Docker Desktop instance and confirm it is running in the background.

### 3. Detected tech stack shows `GENERIC`
* **Cause:** The system could not find any recognizable configuration files at the root level of your archive.
* **Solution:** Verify that your manifest files (`package.json`, `pom.xml`, `requirements.txt`, etc.) are placed at the root level of the `.zip` archive, rather than being nested inside a subfolder.

---

## 5. GUI Desktop Applications vs. Web Services

It is important to understand how the Sandbox environment interacts with different application architectures:

### Web Applications (Spring Boot REST, Express/Node, Django Web, Axum)
* **How they run:** These apps spin up an internal HTTP web server and bind to your selected custom port (e.g., `3001`).
* **Viewing Previews:** You can click the **Open** button in the dashboard logs to view and interact with the application directly inside your web browser.

### GUI/Desktop Applications (Java Swing/AWT, JavaFX)
* **How they run:** These are desktop applications designed to draw user interfaces on a local physical screen using display drivers. They do **not** run a web server.
* **Viewing Previews:** 
  * If run inside a **Docker Container**, they will fail to start because the container is headless (there is no display monitor attached).
  * If run in **Host Fallback Mode (Windows)**, a desktop window will physically launch and pop up on your computer screen directly!
* **Web Browser Behavior:** Opening `http://localhost:3001` in your browser will display `This site can’t be reached` since the GUI application does not listen to web requests.
* **Remediation:** Simply compile the app in the sandbox to verify compilation success and check security vulnerabilities, then click **Download** under Actions to run the compiled JAR locally on your desktop.