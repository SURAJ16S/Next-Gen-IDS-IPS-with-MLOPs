# Architectural Evolution: Docker to Kubernetes (Minikube/k3s) Transition Guide

This document chronicles the architectural evolution of the DevOps AI platform's sidecar infrastructure, highlighting the transition from raw, isolated Docker containers to Docker Compose, and ultimately to a unified, resource-efficient Kubernetes orchestration model (Minikube for local laptop development and k3s for production VPS hosting).

---

## 1. Architectural Stages at a Glance

```text
Stage 1: Isolated Docker Containers
       │
       │ (No central configuration, manually linked)
       ▼
Stage 2: Docker Compose
       │
       │ (Heavy RAM footprint, poor scale & portability)
       ▼
Stage 3: Minikube (Laptop Dev) ──[Identical YAML Manifests]──► Stage 4: k3s (VPS Production)
```

---

## 2. Evolution Walkthrough

### Stage 1: Isolated Docker Containers
Originally, auxiliary services (databases, metric collectors, caches) were started as independent, ad-hoc Docker containers.
* **Characteristics**: Manual scripts running `docker run` commands with exposed ports.
* **Limitations**: 
  - **No Shared Network**: Containers communicated via the host's loopback IP, causing connection errors when addresses changed.
  - **No State Management**: Volumes were not named or centralized, leading to accidental data loss during container updates.
  - **Hard to Orchestrate**: Shutting down the stack required running tedious shell pipe scripts (`docker stop $(docker ps...)`).

---

### Stage 2: Docker Compose (`docker-compose-devops.yml`)
To consolidate services, we unified the stack under a single Docker Compose environment sharing a custom network bridge (`devops-local-net`).
* **Characteristics**: Centrally configured container environments, volumes (`mongo-data`, `pgvector-data`), and networking.
* **Trade-offs**:
  - **Pros**: Simple single-command startup (`docker compose up -d`) and stable container dns references (e.g., `mongodb://database:27017`).
  - **Cons**: 
    - **Resource Heavy**: Docker Desktop on Windows consumed substantial memory on the 8GB host machine.
    - **Lack of VPS Portability**: Direct Docker Compose deployments to production VPS lacked high-availability mechanisms, automated health checks, and stateful scaling.
    - **No Dashboards Auto-Configuration**: Grafana and Prometheus still required manual data source additions and dashboard configuration on fresh installations.

---

### Stage 3: Kubernetes Local Development (Minikube)
We refactored the Docker Compose sidecars into native Kubernetes manifests deployed locally via **Minikube** (using the Docker driver).
* **Characteristics**: 
  - Managed via declarative resources (`Namespace`, `StatefulSet`, `Deployment`, `Service`, `ConfigMap`).
  - Native port-forwarding to make K8s pods look like native host databases.
* **Why we transitioned**:
  - **Resource Capping**: Allowed setting strict CPU and memory limits inside Pod manifests to keep the entire cluster footprint under **~2.8GB RAM**, leaving space for native Ollama runs.
  - **Auto-Provisioning**: Leveraged ConfigMaps to mount Prometheus scrape configs and auto-provision Grafana datasources/dashboards on first boot.
  - **Production-Like Environment**: Code developed on the laptop runs under the exact same orchestrator mechanics as the production server.

---

### Stage 4: Kubernetes Production Hosting (k3s)
For Hostinger KVM4 VPS hosting, we transitioned from Minikube to **k3s**, a highly optimized, lightweight Kubernetes distribution designed by Rancher.
* **Characteristics**: Uses the exact same YAML manifests from `DevOps/k8s/` but utilizes the ultra-lightweight k3s binary instead of full Minikube.
* **Why we transitioned**:
  - **Low Memory Overhead**: k3s server runs in under 512MB RAM, compared to 1.5GB for Minikube.
  - **Security via Localhost Binding**: On the public VPS, databases must never be exposed publicly. Our `start-devops-vps.sh` script binds the `kubectl port-forward` processes strictly to `127.0.0.1`.
  - **API-Based LLM Routing**: In the VPS production environment, local Ollama is omitted. The backend routes LLM requests to Groq or HuggingFace APIs via `.env` credentials, saving 5GB+ RAM and CPU.

---

## 3. Sidecar Configuration Comparison

| Feature | Stage 2: Docker Compose | Stage 3: Minikube (Local) | Stage 4: k3s (VPS) |
|---|---|---|---|
| **RAM Footprint** | ~5-6 GB | ~2.8 GB (Cluster limits) | ~2.1 GB (Excludes local LLM) |
| **Model Hosting** | Native (Host) | Native (Host) | HuggingFace / Groq APIs |
| **Database Security** | Ports exposed to host | Localhost Port-Forward | Restricted to `127.0.0.1` |
| **Grafana Setup** | Manual configuration | Auto-provisioned CM | Auto-provisioned CM |
| **Orchestrator Overhead**| Medium | High (Virtualization Node) | Extremely Low |
| **Volume Scaling** | Host Folders / Volumes | StatefulSet Claim templates | StatefulSet Claim templates |

---

## 4. Portability & Developer Guidelines

### Local Laptop Workflow (Windows/macOS)
1. Run `./start-devops.sh` (or `start-devops.bat` on Windows Cmd) to start the local Minikube cluster and secure port-forwards.
2. In a separate terminal tab, run the backend Node server (`npm run dev` in `Web/backend`).
3. In another terminal tab, run the frontend Vite server (`npm run dev` in `Web/frontend`).
4. View metrics directly on Grafana at `http://localhost:3000`.

### Production VPS Workflow (Hostinger Linux)
1. Clone the repository onto your VPS.
2. Run `sudo ./start-devops-vps.sh` – this audits disk space, installs k3s, deploys the manifests, and sets up secure database port-forwards.
3. Configure `GROQ_API_KEY` or `HUGGINGFACE_API_KEY` inside `Web/backend/.env` to utilize remote cloud LLM endpoints.
4. Run the production builds of the backend/frontend.

---

## 5. Sidecar & Node Directory (Application-Level Usage)

Here is exactly how the services deployed in our Kubernetes namespace are utilized in the platform architecture:

### A. Core Databases & Memory Services
* **`devops-mongodb`**  
  * **Role**: Primary state store.
  * **Our Project's Use**: Stores user login credentials, deployment status history, build logs, file changes, and active session objects.
* **`devops-pgvector`**  
  * **Role**: Semantic and long-term memory engine.
  * **Our Project's Use**: When the Self-Healing agent scans files or handles errors, it queries this PostgreSQL instance to run cosine similarity queries, loading relevant templates or past healing snippets into the LLM context.
* **`devops-redis`**  
  * **Role**: Loop cache & short-term working memory.
  * **Our Project's Use**: Caches current ReAct loop state variables (current iteration, command run history, accumulated observations). If a database update requires user consent, the loop is paused and saved in Redis so it can resume immediately once approved.

### B. Execution & Pipeline Services
* **`untrusted-app-sandbox`**  
  * **Role**: Secure runner namespace.
  * **Our Project's Use**: Dynamically hosts the containerized builds of user projects. It runs them with restricted CPU/RAM, isolated namespaces, and a read-only root directory to prevent malicious code from accessing the host.
* **`devops-registry`**  
  * **Role**: Private Docker registry (Port 5001).
  * **Our Project's Use**: Stores successfully built Docker image assets so the cluster nodes can pull them instantly for preview.
* **`devops-rabbitmq`**  
  * **Role**: Async message broker.
  * **Our Project's Use**: Coordinates communication between the Web backend, agent loops, and execution pipelines. Enqueues new build tasks and streams real-time status updates back to the UI.

### C. Secrets & Observability
* **`devops-vault`**  
  * **Role**: Secrets manager.
  * **Our Project's Use**: Securely encrypts and holds sensitive API tokens (GitHub credentials, Groq API keys, production DB connection URLs). The backend queries Vault dynamically instead of using hardcoded `.env` files.
* **`devops-prometheus`**  
  * **Role**: Metrics scraping collector (Port 9090).
  * **Our Project's Use**: Periodically polls `/metrics` from our Node.js server. Logs total LLM requests, response latency histograms, error rates, and loop run stats.
* **`devops-grafana`**  
  * **Role**: Analytics dashboard (Port 3000).
  * **Our Project's Use**: Displays pre-provisioned panels visualizing loop speed, model failure rate, and codebase patch locations.
* **`ollama`**  
  * **Role**: Local LLM engine (laptop-only).
  * **Our Project's Use**: Runs the `qwen2.5-coder:7b` model to evaluate code structure and write self-healing patch files.

---

## 6. End-to-End Build Lifecycle Walkthrough

Taking the Python Flask + PostgreSQL template (`DevOps/examples/flask-postgres-app`) as a reference, here is the lifecycle of a deployment:

```text
 [1. Web UI] ─────► [2. Node.js Backend] ─────► [3. RabbitMQ Queue]
                            │
                            ├─────► queries [4. Vault] for Secrets
                            │
                            ├─────► compiles Image & pushes to [5. Registry]
                            │
                            ├─────► runs instance inside [6. Sandbox Pod]
                            │
     (If error)             ▼
 [7. ReAct Agent] ◄─────── [Backend Logs Error]
       │
       ├─────► queries [8. pgvector] (Semantic memory search)
       │
       ├─────► requests LLM completion & updates [9. Redis] state cache
       │
       ├─────► applies Patch to sandbox workspace file
       │
       └─────► records Loop diagnostics in [10. Prometheus/Grafana]
```

1. **Infrastructure Provisioning (Terraform Phase)**: Before any code is deployed, Terraform acts as the foundation layer. Running `terraform apply` provisions the isolated namespaces (e.g. `ephemeral-sandbox`) and securely sets up the database connections and JWT keys in `devops-vault`. It maps the token authentication path so that Kubernetes service accounts can interact with Vault.
2. **Trigger**: You select the build on the `/devops` page and click **Start Build**.
3. **Secret Resolution (Vault + Terraform Use Case)**: The Node.js backend uses its Kubernetes service account credentials (trusted by Vault thanks to Terraform config) to authenticate with Vault. It dynamically retrieves the PostgreSQL database credentials stored by Terraform at `secret/data/database/credentials`.
4. **Compilation**: The backend compiles a Docker image containing the Flask app and pushes it to `devops-registry:5001`.
5. **Execution**: The backend deploys the container in the `untrusted-app-sandbox` namespace (which was declared and provisioned by Terraform).
6. **Monitoring**: The app container connects to the `devops-pgvector` service using the credentials injected securely at launch.
7. **Self-Healing Loop**:
   * If the Flask app fails to compile or start (e.g., due to a missing Python package like `psycopg2-binary`), the stdout/stderr logs are captured.
   * The backend invokes the agent loop, passing the log stream.
   * The agent queries `pgvector` for past database configurations.
   * The agent generates a `<patch>` to update `requirements.txt`.
   * The agent runs `pip install` inside the container.
   * On loop success, the server starts, and the loop telemetry (latency, iterations) is scraped by `devops-prometheus`.

---

## 7. Secrets Management with Terraform (For Placements)

Integrating **Terraform** (Infrastructure as Code) into this architecture is an excellent asset for your placement resume, demonstrating practical DevOps engineering.

### How it Works in our Stack
Instead of configuring HashiCorp Vault secrets, policies, and Kubernetes namespaces using manual command-line prompts or the Vault web UI, we use **Terraform** to declare and manage them.

The setup is located at `DevOps/terraform/main.tf` and configures the following:
1. **Kubernetes Provider**: Connects to Minikube or k3s.
2. **Vault Provider**: Points to our local Vault endpoint at `http://127.0.0.1:8200`.
3. **KV Secrets Engine**: Mounts a key-value store (`secret/`) inside Vault.
4. **Secret Storage**: Writes our preview database connection strings securely to `secret/database/credentials`.
5. **Access Policy**: Defines a policy (`devops-backend-policy`) giving read-only access to our application secrets.
6. **Kubernetes Auth Role**: Binds the Vault security policy to Kubernetes service accounts, allowing backend pods to authenticate and fetch secrets dynamically.

### How to run Terraform locally:
1. Make sure your sidecar services are running (run `start-devops.bat` or `./start-devops.sh`).
2. Install Terraform on your machine, then open your terminal inside the `DevOps/terraform` directory.
3. Run:
   ```bash
   terraform init
   ```
   *This downloads the HashiCorp Vault and Kubernetes providers.*
4. Run:
   ```bash
   terraform plan
   ```
   *This displays the execution plan (namespaces, secrets mount, policies).*
5. Apply the plan to provision the resources:
   ```bash
   terraform apply -auto-approve
   ```
---

## 8. RAM Consumption Scaling & Architecture Analogy

### The Paradox: Why is Empty Minikube consuming 2.8GB while 7 Compose Containers took 2.1GB?

This discrepancy is caused by the **Control Plane Overhead**.

1. **Docker Compose (Isolated Host Containers)**:
   * **Base Overhead**: **~0.1 GB**.
   * **Mechanism**: Compose does not run a management engine. It simply passes container instructions to the host's native Docker daemon. When containers are running, you only pay for the Resident Set Size (RSS) of the application processes themselves (MongoDB, MySQL, Node, etc.).
2. **Minikube (Local Kubernetes Cluster)**:
   * **Base Overhead**: **~2.8 GB** (No sandboxes active).
   * **Mechanism**: Minikube runs a complete, nested, single-node Kubernetes cluster inside a single container. Even with zero active builds, the **Kubernetes Control Plane** must run constant reconciliation loops:
     * `kube-apiserver` (API gateway, high memory)
     * `etcd` (highly transactional state database, high memory)
     * `kube-controller-manager` & `kube-scheduler` (state loops)
     * `kubelet` (node agent) & `coredns` (cluster DNS)
     * In addition to the 7 sidecar databases (MongoDB, pgvector, Redis, Grafana, Prometheus, RabbitMQ, Vault) pre-running inside this node.

---

### Scaling Analysis: Hosting 10 Deployments + 10 Databases (20 Pods Total)

Here is a mathematical projection of memory consumption across different startup architectures:

| Resource Component | Stage 2: Docker Compose | Stage 3: Minikube (Laptop) | Stage 4: k3s (VPS Hostinger) |
|---|---|---|---|
| **Base Engine/Control Plane** | ~150 MB | ~1.5 GB | ~512 MB |
| **Pre-run Sidecars (DBs/Grafana)** | ~1.0 GB | ~1.3 GB | ~600 MB (Excludes Ollama) |
| **Incremental Cost per App (x10)** | ~1.5 GB (150MB each) | ~1.6 GB (160MB each) | ~1.5 GB (150MB each) |
| **Incremental Cost per DB (x10)** | ~3.0 GB (300MB each) | ~3.2 GB (320MB each) | ~3.0 GB (300MB each) |
| **Total RAM Consumed (20 Pods)** | **~5.65 GB** | **~7.60 GB** | **~5.61 GB** |
| **Available Host Space (Laptop: 8GB)**| **~2.35 GB** (Swapping starts) | **~0.40 GB** (OOM Crash / Freeze) | N/A |
| **Available Host Space (VPS: 16GB)** | **~10.35 GB** | N/A | **~10.39 GB** (Healthy headroom) |

---

### The Analogy: Hotel vs. Apartments

* **Docker Compose** is like renting **individual apartments**:
  * You only pay for the exact square footage you live in. If you are not in the room, it costs nothing. There is no receptionist, no security guard, and no shared lobby staff. It is highly efficient for small numbers of containers, but hard to coordinate, secure, and scale automatically.
* **Minikube** is like building a **5-story hotel** on a laptop:
  * Even if the hotel is empty, the receptionist, elevator maintenance, security team, lobby heating, and cleaning crew (K8s control plane) must work 24/7. This costs 2.8GB RAM at idle. On an 8GB laptop, this leaves no room for actual guests.
* **k3s (Linux VPS)** is like a **co-living managed space**:
  * It consolidates the master processes (apiserver, scheduler, controller) into a single native process. It runs natively on the host's Linux kernel without nested engine layers or hypervisors, reducing baseline memory down to ~500MB while retaining full Kubernetes scaling, health checks, and secrets control.

---

### Architectural Suggestions & Analogy

1. **For Local Laptop Development (8GB RAM)**:
   * **Suggestion**: Run Minikube to verify Kubernetes configurations, ingress files, or Terraform playbooks, but **restrict concurrent active sandboxes to 1 or 2**. Running 10 active builds on a laptop under Minikube will lead to OOM (Out of Memory) crashes due to the control plane overhead.
2. **For Production VPS (Hostinger KVM4 - 16GB RAM)**:
   * **Suggestion**: **Use k3s**. Because k3s runs natively on the VPS Linux kernel, it avoids the hypervisor overlay of Docker Desktop. You get full enterprise container orchestration, automatic pod restarts, Vault security, and Prometheus scrapers for 10 deployments at only ~5.6GB total RAM, leaving a massive **10.4GB of free headroom** for dynamic traffic surges.
