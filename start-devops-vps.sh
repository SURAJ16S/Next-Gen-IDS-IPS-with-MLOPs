#!/bin/bash

# DevOps Linux VPS Orchestrator & Installer (k3s + K8s sidecars)
# Optimized for Hostinger KVM4 / standard Linux VPS (≤8GB RAM host constraints).

# Enforce running as root/sudo for k3s installation
if [[ $EUID -ne 0 ]]; then
   echo "[ERROR] This installation script must be run with sudo or root privileges."
   echo "        Please run: sudo ./start-devops-vps.sh"
   exit 1
fi

if [[ "$1" == "down" || "$1" == "stop" ]]; then
    echo "===================================================================="
    echo "                  DevOps VPS Sidecars Stopper"
    echo "===================================================================="
    echo "[SYSTEM] Stopping port-forwardings..."
    pkill -f "port-forward" || true
    
    echo "[SYSTEM] Deleting Kubernetes sidecars..."
    if command -v kubectl &> /dev/null; then
        kubectl delete -f DevOps/k8s/ --ignore-not-found=true
    fi
    
    echo "[SUCCESS] Stopped all port-forwardings and sidecars."
    exit 0
fi

echo "===================================================================="
echo "           DevOps VPS Kubernetes Stack Installer & Orchestrator"
echo "===================================================================="
echo ""

# Phase 1: Disk Space Audit & Destination Choice
echo "[SYSTEM] Auditing available disks and partitions..."
df -h | grep -E '^/dev/' | awk '{print "Mount: " $6 " | Total: " $2 " | Used: " $3 " | Free: " $4 " (" $5 ")"}'
echo ""

read -p "Enter the target directory mount path for DevOps PV storage [Default: /opt/devops-data]: " TARGET_DIR
TARGET_DIR=${TARGET_DIR:-/opt/devops-data}

# Create directory to test path
mkdir -p "$TARGET_DIR"

df_info=$(df -h "$TARGET_DIR" | tail -n 1)
disk_name=$(echo "$df_info" | awk '{print $1}')
disk_total=$(echo "$df_info" | awk '{print $2}')
disk_free=$(echo "$df_info" | awk '{print $4}')

# Parse free space size in GB
free_gb=$(echo "$disk_free" | sed 's/[^0-9.]//g')
is_mb=$(echo "$disk_free" | grep -q "M" && echo "true" || echo "false")

if [ "$is_mb" = "true" ] || (( $(echo "$free_gb < 10.0" | bc -l) )); then
    echo "⚠️  [ALERT] Low Disk Space on selected mount: $disk_name ($disk_free free)."
    echo "            Kubernetes sidecar images and data volume claims require at least 10 GB of free space."
    read -p "Do you want to proceed anyway? (y/n): " PROCEED_SPACE
    if [[ ! "$PROCEED_SPACE" =~ ^[Yy]$ ]]; then
        echo "[INFO] Installation aborted by user."
        exit 1
    fi
else
    echo "✅ [OK] Verified $disk_free free space on mount: $disk_name ($disk_total total)."
fi

read -p "Proceed with k3s (Kubernetes) and DevOps sidecars installation? (y/n): " PROCEED_INSTALL
if [[ ! "$PROCEED_INSTALL" =~ ^[Yy]$ ]]; then
    echo "[INFO] Aborted."
    exit 1
fi

# Phase 2: Install k3s (Lightweight Kubernetes)
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Verifying Kubernetes environment..."
if ! command -v k3s &> /dev/null; then
    echo "[SYSTEM] Installing k3s cluster..."
    # Disable traefik ingress controller to save RAM
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
    
    printf "[SYSTEM] Waiting for k3s node to initialize "
    until systemctl is-active --quiet k3s; do
        printf "."
        sleep 3
    done
    echo " [ACTIVE]"
fi

# Set up kubectl alias & config permissions
mkdir -p $HOME/.kube
ln -sf /etc/rancher/k3s/k3s.yaml $HOME/.kube/config
ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
chmod 644 /etc/rancher/k3s/k3s.yaml

echo "[SUCCESS] k3s Kubernetes cluster is online."

# Phase 3: Apply manifests
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Applying Kubernetes sidecars..."
kubectl apply -f DevOps/k8s/namespace.yaml
kubectl apply -f DevOps/k8s/

echo "[SYSTEM] Waiting for sidecar Pods to initialize in namespace 'devops-system'..."
kubectl wait --namespace devops-system \
  --for=condition=ready pod \
  --selector=app=devops-mongodb \
  --timeout=90s || true

# Phase 4: Port Forwarding (bound to 127.0.0.1 for VPS database security)
echo "--------------------------------------------------------------------"
echo "[SYSTEM] Launching secure localhost port-forwardings..."
pkill -f "port-forward" || true
sleep 1

nohup kubectl port-forward -n devops-system statefulset/devops-mongodb 27017:27017 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-redis 6379:6379 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system statefulset/devops-pgvector 5433:5432 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-prometheus 9090:9090 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-grafana 3000:3000 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-rabbitmq 5672:5672 15672:15672 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-vault 8200:8200 --address 127.0.0.1 >/dev/null 2>&1 &
nohup kubectl port-forward -n devops-system deployment/devops-registry 5001:5000 --address 127.0.0.1 >/dev/null 2>&1 &

echo "[SUCCESS] Secure database port-forwardings active on 127.0.0.1."

echo "===================================================================="
echo "⚙️  [VPS PRODUCTION NOTICE]:"
echo "   Ensure you set GROQ_API_KEY or HUGGINGFACE_API_KEY in the backend"
echo "   .env configuration. This routes agent calls to free APIs,"
echo "   avoiding RAM/GPU overhead from local Ollama runs on Hostinger."
echo "===================================================================="
echo "[SUCCESS] DevOps Platform Orchestration Active on VPS!"
echo "===================================================================="
echo "  - MongoDB (Secure)   : 127.0.0.1:27017"
echo "  - Redis Cache        : 127.0.0.1:6379"
echo "  - pgvector DB        : 127.0.0.1:5433 (Memory)"
echo "  - Prometheus metrics : 127.0.0.1:9090"
echo "  - Grafana dashboard  : 127.0.0.1:3000"
echo "===================================================================="
echo "📢 Run your Node.js backend and frontend servers manually now."
echo "   Run './start-devops-vps.sh stop' to clean up all services."
echo "===================================================================="
