# DevOps Platform Operations Guide
## Credentials, Service Access, Terraform Workflows & Daily Troubleshooting

This is the complete operational reference for the DevOps AI Platform. It covers every running service, how to access it, how Terraform manages secrets and infrastructure, and the exact troubleshooting playbook a DevOps engineer follows day-to-day.

---

## 1. Service Directory: Access Links & Credentials

> [!NOTE]
> All services below are accessed on `localhost` via `kubectl port-forward` managed by `start-devops.sh`. Start the stack first before connecting.

### A. Web Interfaces (Browser-Accessible)

| Service | URL | Username | Password | Notes |
|---|---|---|---|---|
| **DevOps Web Portal** | http://localhost:5173 | *(your account)* | *(your account)* | Main UI |
| **Grafana Dashboard** | http://localhost:3000 | `admin` | `admin` | Auto-provisioned dashboards |
| **Prometheus** | http://localhost:9090 | *(none)* | *(none)* | No auth by default |
| **RabbitMQ Management** | http://localhost:15672 | `guest` | `guest` | Queue monitoring |
| **HashiCorp Vault** | http://localhost:8200 | *(token auth)* | `my-secure-token` | Secrets manager |
| **Minikube K8s Dashboard** | Auto-opens on start | *(none)* | *(none)* | Full cluster view |

---

### B. Database Services (Client/Driver-Accessible — NOT HTTP)

> [!IMPORTANT]
> pgvector, MongoDB, and Redis are **database protocols**, not web servers. You cannot open them in a browser. You connect via a database client, driver, or CLI tool.

#### pgvector (PostgreSQL + Vector Extension)
* **Connection String**: `postgresql://postgres:postgres@localhost:5433/agent_memory`
* **Port**: `5433` (mapped from internal cluster port `5432`)
* **GUI Client**: Use **pgAdmin 4** or **DBeaver** → New Connection → PostgreSQL → host: `localhost`, port: `5433`, db: `agent_memory`, user: `postgres`, password: `postgres`
* **CLI Access**:
  ```bash
  psql -h 127.0.0.1 -p 5433 -U postgres -d agent_memory
  ```
* **What it stores**: Agent episodic memory embeddings, semantic search vectors, past healing event history.

#### MongoDB
* **Connection String**: `mongodb://localhost:27017`
* **GUI Client**: **MongoDB Compass** → Paste connection string directly
* **CLI Access**:
  ```bash
  mongosh mongodb://localhost:27017
  ```
* **What it stores**: User accounts, deployment records, build logs, chat sessions, DevOps job queue.

#### Redis
* **Connection String**: `redis://localhost:6379`
* **CLI Access**:
  ```bash
  redis-cli -h 127.0.0.1 -p 6379
  KEYS *        # List all active keys
  GET react_loop_state:<chatId>   # Inspect paused ReAct loop state
  ```
* **What it stores**: Active ReAct loop state (paused iteration data), short-term working memory cache.

#### Private Docker Registry
* **Push/Pull endpoint**: `localhost:5001`
* **Usage**: Push built images → `docker tag myapp localhost:5001/myapp:latest && docker push localhost:5001/myapp:latest`

---

## 2. Terraform Real-World Usage in This Project

### What Terraform Does Here (Not Theory — Actual Project Use)

Terraform (`DevOps/terraform/main.tf`) manages **three things** in our platform:

#### Use Case 1: Provision the Isolated Sandbox Namespace
When a user uploads a new project (e.g., Flask app) on the `/devops` page, the container for that build must run **inside an isolated Kubernetes namespace** with strict resource limits (no network egress, read-only filesystem, dropped capabilities).

Without Terraform, you'd have to run:
```bash
kubectl create namespace ephemeral-sandbox
kubectl label namespace ephemeral-sandbox security=isolated-sandbox
```
...manually, every time. With Terraform:
```bash
cd DevOps/terraform
terraform apply
# → Creates the namespace declaratively, tracked in state file
```
If you destroy and recreate your cluster, `terraform apply` rebuilds all namespaces, policies, and secrets in one shot.

---

#### Use Case 2: Store Database Credentials Securely in Vault (Not .env Files!)
Without Terraform, a developer might hardcode this in `.env`:
```
POSTGRES_URL=postgres://postgres:postgres@localhost:5433/agent_memory
JWT_SECRET=my-super-secret-key
```
This is a **security vulnerability** — if the file leaks, credentials are exposed.

With Terraform + Vault:
```hcl
resource "vault_kv_secret_v2" "db_credentials" {
  mount = "secret"
  name  = "database/credentials"
  data_json = jsonencode({
    mongodb_url  = "mongodb://..."
    postgres_url = "postgresql://..."
    jwt_secret   = "super-secret-key"
  })
}
```
The Node.js backend then fetches these at runtime:
```javascript
// Instead of process.env.POSTGRES_URL → fetch from Vault
const secret = await vault.read('secret/data/database/credentials');
const postgresUrl = secret.data.data.postgres_url;
```
Credentials **never live in files**. They exist only in Vault's encrypted storage.

---

#### Use Case 3: Kubernetes Auth Binding (Zero-Trust Secret Access)
Terraform configures Vault to trust Kubernetes Service Accounts. This means when the Node.js backend pod starts inside `devops-system`, it authenticates with Vault using its K8s identity token (not a hardcoded token). If someone steals the container image, they get nothing — the secrets stay in Vault.

---

### How to Run Terraform in This Project:
```bash
# 1. Start the stack first
./start-devops.sh

# 2. Move into terraform directory
cd DevOps/terraform

# 3. Download providers (only first time)
terraform init

# 4. Preview what will be created/changed
terraform plan

# 5. Apply all changes
terraform apply -auto-approve

# 6. To destroy all managed resources
terraform destroy -auto-approve
```

---

## 3. Daily DevOps Engineer Workflow

### Morning Health Check (Every Day, First Thing)

```bash
# 1. Check all pods are Running (none in CrashLoopBackOff or Error)
kubectl get pods -n devops-system

# 2. Check pod resource consumption (CPU/RAM)
kubectl top pods -n devops-system

# 3. Check active port-forwards are alive
netstat -an | grep -E "27017|6379|5433|9090|3000|15672|8200"

# 4. Open Grafana → http://localhost:3000
# → Check "LLM Inference Latency" panel for any spikes
# → Check "Agent Failures / Errors" stat — should be 0
```

---

## 4. Troubleshooting Playbook (Scenario-Based)

---

### Scenario 1: A Build Preview Won't Start (Container Stuck at "Building...")

**Symptoms**: User uploads Flask app, progress bar stays at "Building..." forever.

**Investigation Steps**:
```bash
# Step 1: Find the specific build container
docker ps | grep devops-preview

# Step 2: Check the build container logs for compile errors
docker logs devops-preview-<jobId> --tail=50

# Step 3: Check the Node.js backend logs for error messages
# (in the npm run dev terminal)
# Look for: [DEVOPS CONTROLLER] Build failed: ...

# Step 4: Check if the Docker registry is accessible
curl http://localhost:5001/v2/   # Should return {}

# Step 5: Check disk space (OOM during build is common)
docker system df
```

**Common Fixes**:
* `requirements.txt` missing → Agent will auto-patch (ensure Ollama is running: `curl http://localhost:11434/api/tags`)
* Registry down → `kubectl rollout restart deployment devops-registry -n devops-system`
* Disk full → `docker system prune -f`

---

### Scenario 2: Agent Chat Returns "Error connecting to model"

**Symptoms**: User sends a message in Agent chat, gets: *"I encountered an error connecting to the model"*.

**Investigation Steps**:
```bash
# Step 1: Check Ollama is running (laptop)
curl http://127.0.0.1:11434/api/tags

# Step 2: If using Groq API (VPS) — test the key
curl https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY"

# Step 3: Check backend .env for correct routing config
cat Web/backend/.env | grep -E "GROQ|HUGGING|OLLAMA"

# Step 4: Check the backend console for the exact error message
# Look for: [REACT LOOP] LLM call error: ...
```

**Common Fixes**:
* Ollama crashed → `ollama serve &`
* Wrong model name → `ollama list` to verify `qwen2.5-coder:7b` is present
* Groq rate limit (VPS) → Switch to `HUGGINGFACE_API_KEY` in `.env`

---

### Scenario 3: Grafana Shows No Data / "N/A" on All Panels

**Symptoms**: Grafana opens but all panels show "No data" or "N/A".

**Investigation Steps**:
```bash
# Step 1: Verify Prometheus is scraping the backend successfully
# Open → http://localhost:9090/targets
# → "devops-backend" job should show State: UP

# Step 2: Test the metrics endpoint directly
curl http://localhost:5000/metrics
# Should output many lines of prom-client metrics

# Step 3: If metrics endpoint 404s → server hasn't reloaded yet
# Restart backend: Ctrl+C in the backend terminal, then npm run dev

# Step 4: Check if Prometheus can reach the backend from inside cluster
kubectl exec -n devops-system deploy/devops-prometheus -- \
  wget -qO- http://host.minikube.internal:5000/metrics | head -20
```

**Common Fixes**:
* Backend not running → `npm run dev` in `Web/backend`
* Prometheus target unreachable from cluster → Edit `prometheus.yaml` to use correct `host.minikube.internal` hostname
* Grafana datasource misconfigured → Go to `http://localhost:3000/connections/datasources` → test Prometheus connection

---

### Scenario 4: Pod in CrashLoopBackOff

**Symptoms**: `kubectl get pods -n devops-system` shows a pod with status `CrashLoopBackOff`.

```bash
# Step 1: Get the crash reason
kubectl logs -n devops-system <pod-name> --tail=30

# Step 2: Describe the pod for K8s-level errors (OOMKilled, etc.)
kubectl describe pod -n devops-system <pod-name>

# Step 3: If OOMKilled → the pod exceeded its memory limit
# Increase limit in the corresponding yaml file, then:
kubectl apply -f DevOps/k8s/<service>.yaml
kubectl rollout restart deployment <service-name> -n devops-system

# Step 4: If ConfigMap error (e.g., Grafana dashboards.yml is a directory)
# Fix the ConfigMap mount in the yaml, then re-apply
kubectl apply -f DevOps/k8s/grafana.yaml
kubectl rollout restart deployment devops-grafana -n devops-system
```

---

### Scenario 5: pgvector "Connection Refused" from Backend

**Symptoms**: Backend agent memory service logs: `ECONNREFUSED 127.0.0.1:5433`.

```bash
# Step 1: Confirm port-forward is alive
netstat -an | grep 5433    # Should show LISTENING

# Step 2: If not listening, restart the port-forward
kubectl port-forward -n devops-system statefulset/devops-pgvector 5433:5432 &

# Step 3: Test the connection
psql -h 127.0.0.1 -p 5433 -U postgres -d agent_memory -c "\dt"

# Step 4: Check pgvector pod is Running
kubectl get pod devops-pgvector-0 -n devops-system
```

---

### Scenario 6: HashiCorp Vault Sealed / Inaccessible

**Symptoms**: Vault UI shows "Vault is sealed" or backend cannot fetch secrets.

```bash
# Step 1: Check Vault status
curl http://127.0.0.1:8200/v1/sys/health | python -m json.tool

# Step 2: If sealed, unseal it (dev mode should auto-unseal)
curl -X PUT http://127.0.0.1:8200/v1/sys/unseal \
  -H "Content-Type: application/json" \
  -d '{"key": "my-secure-token"}'

# Step 3: If the Vault pod restarted, re-run Terraform to re-provision secrets
cd DevOps/terraform
terraform apply -auto-approve
```

---

## 5. Resource Monitoring Quick Reference

```bash
# Live pod CPU/RAM (like top for K8s)
kubectl top pods -n devops-system

# View logs for any pod in real-time
kubectl logs -f -n devops-system deploy/devops-prometheus

# List all K8s resources in devops-system
kubectl get all -n devops-system

# Check PersistentVolumeClaims (database disk usage)
kubectl get pvc -n devops-system

# Force delete a stuck pod (it will auto-recreate)
kubectl delete pod -n devops-system <pod-name> --force

# View Terraform-managed resources
cd DevOps/terraform && terraform show
```
