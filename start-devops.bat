@echo off
rem DevOps Local Stack Orchestrator for Windows CMD/PowerShell

if "%1"=="stop" goto stop
if "%1"=="down" goto stop

set PATH=D:\Minikube;%PATH%

echo ====================================================================
echo                   DevOps Platform Startup Script
echo ====================================================================
echo [SYSTEM] Checking Docker daemon status...
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Docker daemon is not active. Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    printf "[SYSTEM] Waiting for Docker daemon to initialize "
    :docker_wait
    timeout /t 5 >nul
    docker info >nul 2>&1
    if %errorlevel% neq 0 (
        goto docker_wait
    )
    echo  [CONNECTED]
)

echo [SUCCESS] Docker daemon is connected.

echo --------------------------------------------------------------------
echo [SYSTEM] Checking Minikube status...
minikube status | findstr /i "Running" >nul 2>&1
if %errorlevel% neq 0 (
    echo [SYSTEM] Starting Minikube cluster (allocating 4GB RAM, 4 CPUs)...
    minikube start --driver=docker --memory=4096 --cpus=4
)
echo [SUCCESS] Minikube is active.

echo --------------------------------------------------------------------
echo [SYSTEM] Deploying Kubernetes sidecars...
kubectl apply -f DevOps\k8s\namespace.yaml
kubectl apply -f DevOps\k8s\

echo [SYSTEM] Waiting for database pods to launch...
timeout /t 10 >nul

echo --------------------------------------------------------------------
echo [SYSTEM] Setting up port-forwardings...
taskkill /f /im kubectl.exe >nul 2>&1
timeout /t 1 >nul

start /B kubectl port-forward -n devops-system statefulset/devops-mongodb 27017:27017 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-redis 6379:6379 >nul 2>&1
start /B kubectl port-forward -n devops-system statefulset/devops-pgvector 5433:5432 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-prometheus 9090:9090 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-grafana 3000:3000 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-rabbitmq 5672:5672 15672:15672 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-vault 8200:8200 >nul 2>&1
start /B kubectl port-forward -n devops-system deployment/devops-registry 5001:5000 >nul 2>&1

echo [SUCCESS] Port-forwardings launched in background.

echo --------------------------------------------------------------------
echo [SYSTEM] Verifying native Ollama service...
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo [SYSTEM] Launching native Ollama...
    start /B ollama serve >nul 2>&1
    timeout /t 5 >nul
)
curl -s http://127.0.0.1:11434/api/tags | findstr "qwen2.5-coder:7b" >nul 2>&1
if %errorlevel% neq 0 (
    echo [SYSTEM] Pulling model qwen2.5-coder:7b in background...
    start /B ollama pull qwen2.5-coder:7b >nul 2>&1
) else (
    echo [SUCCESS] Ollama qwen2.5-coder:7b cached.
)

echo --------------------------------------------------------------------
echo [INFO] Start the backend and frontend dev servers manually in separate CMD terminals.

echo [SYSTEM] Launching Minikube Kubernetes Dashboard...
start /B minikube dashboard >nul 2>&1

echo ====================================================================
echo [SUCCESS] DevOps Platform Orchestration Active!
echo ====================================================================
echo   - DevOps Web Portal   : http://localhost:5173
echo   - Prometheus metrics  : http://localhost:9090
echo   - Grafana dashboard   : http://localhost:3000 (auto-provisioned)
echo   - pgvector DB Storage : postgres://postgres:postgres@localhost:5433/agent_memory
echo ====================================================================
echo [INFO] Run "start-devops.bat stop" to stop dev servers & port-forwards.
echo ====================================================================
goto end

:stop
echo [SYSTEM] Stopping port-forwards & Kubernetes sidecars...
taskkill /f /im kubectl.exe >nul 2>&1
kubectl delete -f DevOps\k8s\ --ignore-not-found=true >nul 2>&1
echo [SUCCESS] Stopped all port-forwarding and cluster resources.
goto end

:end
