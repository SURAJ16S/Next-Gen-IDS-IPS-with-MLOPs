#!/bin/bash

# DevOps Windows Laptop Orchestrator (Minikube + Local Port-Forwarding)
# Runs stateful sidecar containers inside Minikube on Windows.

# Add user AppData bin path to local session PATH if docker/kubectl is not registered globally
if ! command -v docker &> /dev/null; then
    if [[ -d "$HOME/AppData/Local/Programs/DockerDesktop/resources/bin" ]]; then
        export PATH="$HOME/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
    fi
fi
if ! command -v kubectl &> /dev/null; then
    if [[ -d "/c/Program Files/Kubernetes/Minikube" ]]; then
        export PATH="/c/Program Files/Kubernetes/Minikube:$PATH"
    fi
fi
if [[ -d "/d/Minikube" ]]; then
    export PATH="/d/Minikube:$PATH"
fi

if [[ "$1" == "down" || "$1" == "stop" ]]; then
    echo "===================================================================="
    echo "            DevOps Windows Laptop Sidecars Stopper"
    echo "===================================================================="
    echo "[SYSTEM] Stopping Kubernetes port-forwardings..."
    pkill -f "port-forward" || true
    
    echo "[SYSTEM] Deleting Kubernetes sidecars..."
    kubectl delete -f DevOps/k8s/ --ignore-not-found=true
    
    echo "[SUCCESS] All port-forwardings and sidecars stopped."
    exit 0
fi

echo "===================================================================="
# Hostinger VPS K3s deployment check notice
echo "💡 To deploy this same stack to your Hostinger KVM4 VPS:"
echo "   Simply run: kubectl apply -f DevOps/k8s/"
echo "===================================================================="
echo ""
echo "[SYSTEM] Checking Docker daemon status..."

if ! docker info >/dev/null 2>&1; then
    echo "[WARNING] Docker daemon is not running!"
    echo "[SYSTEM] Attempting to launch Docker Desktop..."
    
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
        if [[ -f "/c/Program Files/Docker/Docker/Docker Desktop.exe" ]]; then
            "/c/Program Files/Docker/Docker/Docker Desktop.exe" &
        elif [[ -f "$HOME/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe" ]]; then
            "$HOME/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe" &
        elif [[ -f "$HOME/AppData/Local/Programs/Docker Desktop/Docker Desktop.exe" ]]; then
            "$HOME/AppData/Local/Programs/Docker Desktop/Docker Desktop.exe" &
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        open --background -a Docker
    else
        sudo systemctl start docker
    fi
    
    printf "[SYSTEM] Waiting for Docker daemon to initialize "
    until docker info >/dev/null 2>&1; do
        printf "."
        sleep 5
    done
    echo " [CONNECTED]"
fi

echo "[SUCCESS] Docker daemon is active."

# Start Minikube
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Checking Minikube status..."
if ! command -v minikube &> /dev/null; then
    echo "[ERROR] Minikube is not installed. Please install Minikube to proceed."
    exit 1
fi

if ! minikube status | grep -q "Running"; then
    echo "[SYSTEM] Starting Minikube cluster (allocating 4GB RAM, 4 CPUs)..."
    minikube start --driver=docker --memory=4096 --cpus=4
fi
echo "[SUCCESS] Minikube cluster is active."

# Apply Kubernetes manifests
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Applying Kubernetes manifests..."
kubectl apply -f DevOps/k8s/namespace.yaml
kubectl apply -f DevOps/k8s/

echo "[SYSTEM] Waiting for sidecar Pods to be ready in 'devops-system' namespace..."
kubectl wait --namespace devops-system \
  --for=condition=ready pod \
  --selector=app=devops-mongodb \
  --timeout=90s || true

# Setup Port Forwarding
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Setting up localhost port-forwardings..."
# Stop any existing port-forward processes to prevent address-in-use conflicts
pkill -f "port-forward" || true
sleep 1

kubectl port-forward -n devops-system statefulset/devops-mongodb 27017:27017 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-redis 6379:6379 >/dev/null 2>&1 &
kubectl port-forward -n devops-system statefulset/devops-pgvector 5433:5432 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-prometheus 9090:9090 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-grafana 3000:3000 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-rabbitmq 5672:5672 15672:15672 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-vault 8200:8200 >/dev/null 2>&1 &
kubectl port-forward -n devops-system deployment/devops-registry 5001:5000 >/dev/null 2>&1 &

echo "[SUCCESS] Port-forwardings established successfully."

# Start native Ollama (laptop-only config)
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Verifying local Ollama service..."
if ! command -v ollama &> /dev/null; then
    if [[ -d "$HOME/AppData/Local/Programs/Ollama" ]]; then
        export PATH="$HOME/AppData/Local/Programs/Ollama:$PATH"
    fi
fi

if command -v ollama &> /dev/null; then
    if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        echo "[SYSTEM] Launching native Ollama daemon..."
        ollama serve & >/dev/null 2>&1
        sleep 5
    fi
    if curl -s http://127.0.0.1:11434/api/tags | grep -q "qwen2.5-coder:7b"; then
        echo "[SUCCESS] Ollama qwen2.5-coder:7b model cache verified."
    else
        echo "[SYSTEM] Pulling model qwen2.5-coder:7b (this runs in background)..."
        ollama pull qwen2.5-coder:7b &
    fi
fi

# Native dev servers can be started manually in separate terminals
echo "[INFO] Start the backend and frontend dev servers manually in separate terminal windows."

echo "[SYSTEM] Launching Minikube Kubernetes Dashboard..."
minikube dashboard &

echo "===================================================================="
echo "[SUCCESS] DevOps Platform Orchestration Active!"
echo "===================================================================="
echo "  - DevOps Web Portal   : http://localhost:5173"
echo "  - Prometheus metrics  : http://localhost:9090"
echo "  - Grafana dashboard   : http://localhost:3000 (auto-provisioned)"
echo "  - pgvector DB Storage : postgres://postgres:postgres@localhost:5433/agent_memory"
echo "===================================================================="
echo "[INFO] Run './start-devops.sh stop' to clean up all services."
echo "===================================================================="
