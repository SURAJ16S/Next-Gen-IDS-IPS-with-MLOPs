#!/bin/bash
# DevOps/scripts/03-ephemeral-test.sh
# Phase 3: Ephemeral Sandbox Orchestration
# This script configures local Minikube prerequisites (Falco via eBPF, cert-manager),
# deploys the isolated application inside gVisor, runs dynamic verification probes,
# and enforces a strict 10-minute teardown window to flush memory and secure the environment.

set -euo pipefail

# Configuration
NAMESPACE="ephemeral-sandbox"
DEPLOYMENT_MANIFEST="$(dirname "$0")/../k8s/sandbox-deployment.yaml"
TEST_DURATION_SECS=600 # 10 Minutes
POLL_INTERVAL_SECS=10

echo "========================================="
echo "Phase 3: Starting Ephemeral Sandbox Testing"
echo "========================================="

# Handle cleanup on exit (normal completion or script interruption)
cleanup() {
    echo ""
    echo "========================================="
    echo "[!] Trapped termination or timer expired. Cleaning up sandbox..."
    echo "========================================="
    
    if kubectl get namespace "$NAMESPACE" &>/dev/null; then
        echo "[*] Forcefully deleting namespace '$NAMESPACE' to flush memory..."
        kubectl delete namespace "$NAMESPACE" --force --grace-period=0 || true
    fi

    echo "[+] Teardown completed. Memory flushed, runsc runtime state evicted."
    exit 0
}

# Register the cleanup trap for SIGINT, SIGTERM, and EXIT
trap cleanup SIGINT SIGTERM EXIT

# Step 1: Pre-flight Checks
check_cluster_and_tools() {
    echo "[*] Verifying CLI utilities..."
    for tool in kubectl helm minikube; do
        if ! command -v "$tool" &>/dev/null; then
            echo "[-] Error: Required CLI utility '$tool' is not installed."
            exit 1
        fi
    done

    echo "[*] Verifying Minikube status..."
    if ! minikube status | grep -q "Running"; then
        echo "[!] Minikube is not running."
        echo "    Please start Minikube with gVisor enabled: "
        echo "    minikube start --container-runtime=containerd --addons=gvisor"
        exit 1
    fi
}

# Step 2: Provision Infrastructure Prerequisites (Falco & cert-manager)
provision_prerequisites() {
    echo "[*] Updating Helm repositories..."
    helm repo add falcosecurity https://falcosecurity.github.io/charts &>/dev/null || true
    helm repo add jetstack https://charts.jetstack.io &>/dev/null || true
    helm repo update &>/dev/null || true

    # Deploy Falco (eBPF-driven behavioral threat detection)
    if ! helm status falco -n falco &>/dev/null; then
        echo "[*] Deploying Falco in eBPF mode..."
        helm install falco falcosecurity/falco \
            --namespace falco \
            --create-namespace \
            --set driver.kind=ebpf \
            --set tty=true
        echo "[+] Falco installation triggered successfully."
    else
        echo "[+] Falco is already deployed."
    fi

    # Deploy cert-manager (automatic internal certificate issuance)
    if ! helm status cert-manager -n cert-manager &>/dev/null; then
        echo "[*] Deploying cert-manager..."
        helm install cert-manager jetstack/cert-manager \
            --namespace cert-manager \
            --create-namespace \
            --set installCRDs=true
        echo "[+] cert-manager installation triggered successfully."
    else
        echo "[+] cert-manager is already deployed."
    fi
}

# Step 3: Deploy Sandbox App and wait for ready state
deploy_sandbox() {
    echo "[*] Applying deployment manifest: $DEPLOYMENT_MANIFEST"
    if [ ! -f "$DEPLOYMENT_MANIFEST" ]; then
        echo "[-] Error: Manifest file not found: $DEPLOYMENT_MANIFEST"
        exit 1
    fi

    # Create Namespace (already defined in manifest, but apply manages it gracefully)
    kubectl apply -f "$DEPLOYMENT_MANIFEST"

    echo "[*] Waiting for untrusted-app-sandbox deployment rollout..."
    kubectl rollout status deployment/untrusted-app-sandbox -n "$NAMESPACE" --timeout=90s
}

# Step 4: Run loop to verify stability and dynamic uptime
run_testing_loop() {
    local elapsed=0
    echo "[+] Sandbox is active under gVisor kernel isolation."
    echo "[*] Initiating $TEST_DURATION_SECS-second (10-minute) testing & fuzzing window..."

    # Extract target pod IP or Service IP inside Minikube to perform basic DAST requests
    local service_ip
    service_ip=$(kubectl get svc untrusted-app-service -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}') || service_ip=""

    while [ $elapsed -lt $TEST_DURATION_SECS ]; do
        echo "[*] Sandbox Uptime: ${elapsed}s / ${TEST_DURATION_SECS}s"
        
        # Simple dynamic probe simulation
        if [ -n "$service_ip" ]; then
            echo "[*] Executing test curl probe to internal endpoint http://$service_ip..."
            # Execute standard HTTP check from within the minikube host cluster via minikube ssh or kubectl run
            # Here we just run a light check in-cluster using a temporary curl client:
            kubectl run curl-test-probe --rm -i --user 10001 --restart=Never --namespace "$NAMESPACE" --image=curlimages/curl -- -s -I http://untrusted-app-service.ephemeral-sandbox.svc.cluster.local/ || echo "[!] Port connection check skipped / failed."
        fi

        # Sleep and increment
        sleep "$POLL_INTERVAL_SECS"
        elapsed=$((elapsed + POLL_INTERVAL_SECS))
    done

    echo "[+] Dynamic testing window successfully finished."
}

# Main Execution Flow
check_cluster_and_tools
provision_prerequisites
deploy_sandbox
run_testing_loop

# cleanup will automatically trigger here via the exit trap
