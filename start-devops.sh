#!/bin/bash

# DevOps Local Stack Orchestrator for Unix / Git Bash
if [[ "$1" == "down" || "$1" == "stop" ]]; then
    echo "===================================================================="
    echo "                  DevOps Local Sidecars Orchestrator"
    echo "===================================================================="
    echo "[SYSTEM] Stopping all DevOps sidecar containers..."
    
    # Add user AppData bin path to local session PATH if docker is not registered globally
    if ! command -v docker &> /dev/null; then
        if [[ -d "$HOME/AppData/Local/Programs/DockerDesktop/resources/bin" ]]; then
            export PATH="$HOME/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
        fi
    fi
    
    cd DevOps || exit 1
    docker compose -f docker-compose-devops.yml down
    cd ..
    echo "[SUCCESS] All DevOps services stopped."
    exit 0
fi

echo "===================================================================="
echo "                  DevOps Local Sidecars Orchestrator"
echo "===================================================================="
echo "[SYSTEM] Checking Docker status..."

# Add user AppData bin path to local session PATH if docker is not registered globally
if ! command -v docker &> /dev/null; then
    if [[ -d "$HOME/AppData/Local/Programs/DockerDesktop/resources/bin" ]]; then
        export PATH="$HOME/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
    fi
fi

if ! docker info >/dev/null 2>&1; then
    echo "[WARNING] Docker daemon is not running!"
    echo "[SYSTEM] Attempting to launch Docker Desktop..."
    
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
        # Windows environment via Git Bash (run in background)
        if [[ -f "/c/Program Files/Docker/Docker/Docker Desktop.exe" ]]; then
            "/c/Program Files/Docker/Docker/Docker Desktop.exe" &
        elif [[ -f "$HOME/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe" ]]; then
            "$HOME/AppData/Local/Programs/DockerDesktop/Docker Desktop.exe" &
        elif [[ -f "$HOME/AppData/Local/Programs/Docker Desktop/Docker Desktop.exe" ]]; then
            "$HOME/AppData/Local/Programs/Docker Desktop/Docker Desktop.exe" &
        else
            echo "[ERROR] Docker Desktop could not be found in standard or AppData locations."
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        open --background -a Docker
    else
        # Linux
        sudo systemctl start docker
    fi
    
    printf "[SYSTEM] Waiting for Docker daemon to initialize (this takes 30-60s) "
    until docker info >/dev/null 2>&1; do
        printf "."
        sleep 5
    done
    echo " [CONNECTED]"
fi

echo "[SUCCESS] Docker daemon is connected and active."
echo "[SYSTEM] Starting all DevOps sidecar containers..."
echo "--------------------------------------------------------------------"

cd DevOps || exit 1
docker compose -f docker-compose-devops.yml up -d
cd ..

echo "--------------------------------------------------------------------"
echo "[SUCCESS] All DevOps services launched successfully!"
echo "===================================================================="
echo ""
echo "  - DevOps Web Portal   : http://localhost:5173"
echo "  - Local Database (Mongo): mongodb://localhost:27017"
echo "  - Prometheus Metrics  : http://localhost:9090"
echo "  - Grafana Dashboards  : http://localhost:3000"
echo "  - HashiCorp Secrets   : http://localhost:8200 (Token: my-secure-token)"
echo "  - RabbitMQ Management : http://localhost:15672 (guest/guest)"
echo "  - Private Registry    : http://localhost:5001"
echo ""
echo "===================================================================="
echo "[INFO] Run 'docker compose -f DevOps/docker-compose-devops.yml down' to stop."
echo "===================================================================="
