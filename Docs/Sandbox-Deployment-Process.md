# Container Sandbox Deployment Process

This document outlines how the DevOps Platform invokes, manages, and cleans up deployment containers, highlighting architectural differences between Windows and Linux.

---

## 1. How the Sandbox Container is Invoked

The platform uses the **`dockerode`** library to communicate with the Docker engine via Unix Sockets (`/var/run/docker.sock`) or Named Pipes on Windows (`\\.\pipe\docker_engine`).

### Container Creation Parameters
When a build succeeds, a new container is provisioned with these strict specifications:

```javascript
activeDocker.createContainer({
  Image: 'node:20-alpine',
  Cmd: containerCmd,
  name: `devops-preview-${jobId}`,
  HostConfig: {
    Binds: [`${path.resolve(workDir)}:/workspace`], // Workspace bind mount
    PortBindings: {
      [`${port}/tcp`]: [{ HostPort: String(port) }] // Dynamic port mapping
    },
    Memory: 512 * 1024 * 1024,      // 512MB RAM ceiling
    NanoCpus: 1000000000,          // 1 CPU core allocation limit
    NetworkMode: 'bridge'
  }
});
```

* **Storage Isolation:** Volume bind mount limits the container to read/write only inside `/workspace` or `/project`.
* **Network Isolation:** Maps the container port to the allocated preview port on the host machine.

---

## 2. Windows vs. Linux Architectural Differences

The DevOps platform's runtime behavior is highly dependent on the host operating system:

| Feature | Linux Environment | Windows Environment |
|---|---|---|
| **Container Engine** | Native Docker daemon | Docker Desktop running inside WSL2 virtual machine |
| **Sandboxing Runtime** | **gVisor (`runsc`)** security kernel | Standard namespaces (or gVisor disabled) |
| **Local Port Relay** | Direct network interface mapping | Port forwarding via WSL gateway (`wslrelay.exe`) |
| **Host Fallback Mode** | Spawns background process via shell (`&`) | Spawns background process with Windows cmd / PID |
| **Process Cleanup** | `pkill -P {pid}` / SIGKILL signals | `taskkill /pid {pid} /T /F` process tree termination |

---

## 3. How to Set Up and Run in Linux (gVisor Core)

In production Linux environments (e.g. Ubuntu servers), containers run inside **gVisor** (Google's virtualization kernel) to prevent container escape exploits.

### Step 1: Install gVisor (`runsc`)
1. Download and install the gVisor key and repository:
   ```bash
   curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://gvisor.dev/apt stable main" | sudo tee /etc/apt/sources.list.d/gvisor.list
   sudo apt-get update && sudo apt-get install -y runsc
   ```
2. Register the `runsc` runtime with Docker inside `/etc/docker/daemon.json`:
   ```json
   {
     "runtimes": {
       "runsc": {
         "path": "/usr/bin/runsc"
       }
     }
   }
   ```
3. Restart the Docker daemon:
   ```bash
   sudo systemctl restart docker
   ```

### Step 2: Invoke the Container with gVisor
When spawning containers on Linux, the backend injects the `Runtime: "runsc"` parameter:
```javascript
activeDocker.createContainer({
  Image: 'node:20-alpine',
  Cmd: containerCmd,
  name: containerName,
  Runtime: 'runsc', // Instructs Docker to use gVisor's secure kernel
  HostConfig: {
    Binds: [containerBind],
    PortBindings: { [`${port}/tcp`]: [{ HostPort: String(port) }] }
  }
});
```

---

## 4. How to Set Up and Run in Windows (WSL2 & Host Fallback)

On Windows machines (like this development environment), the platform leverages Docker Desktop (with WSL2) and includes a native process runner fallback.

### Step 1: Set Up Docker Desktop
1. Enable the **WSL2 feature** in Windows features.
2. Install **Docker Desktop** and check **Use the WSL 2 based engine** under Settings.
3. Verify the named pipe is active by running `docker ps` in PowerShell.

### Step 2: Host Process Fallback Mode
If Docker is not running or fails to initialize, the platform automatically drops back to **Host Fallback Mode**.
* **Spawning:** The platform invokes the start command directly on the host using Node's `child_process.exec`:
  ```javascript
  const child = exec(serverStartCmd, {
    cwd: workDir,
    env: { ...process.env, PORT: port, NODE_ENV: 'production' }
  });
  ```
* **Process Tracking:** The process ID (PID) is saved to MongoDB:
  ```javascript
  await Deployment.findByIdAndUpdate(deploymentId, { previewPid: child.pid });
  ```

### Step 3: Windows Process Tree Cleanup
Because Node sub-processes (like database connections or Vite watches) spawn child sub-processes, killing the parent PID directly leaves "ghost" processes running. 
To prevent this, the cleanup command on Windows uses `/T` (tree kill) and `/F` (force):
```javascript
// Terminate the process tree on Windows host
exec(`taskkill /pid ${pid} /T /F`);
```
This guarantees that all child processes listening on the port are terminated completely.
