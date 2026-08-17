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

echo "--------------------------------------------------------------------"
echo "[SYSTEM] Verifying local Ollama service for Self-Healing agent..."
# Pre-scan standard Windows installation paths to register Ollama in the current Git Bash shell session
if ! command -v ollama &> /dev/null; then
    if [[ -d "$HOME/AppData/Local/Programs/Ollama" ]]; then
        export PATH="$HOME/AppData/Local/Programs/Ollama:$PATH"
    elif [[ -d "/c/Program Files/Ollama" ]]; then
        export PATH="/c/Program Files/Ollama:$PATH"
    fi
fi

if ! command -v ollama &> /dev/null; then
    echo "[WARNING] Ollama is not installed or not in PATH."
    echo "[SYSTEM] Attempting to automatically install Ollama..."
    
    INSTALL_SUCCESS=false
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
        # Windows via Git Bash / PowerShell
        if powershell -Command "irm https://ollama.com/install.ps1 | iex"; then
            INSTALL_SUCCESS=true
        fi
    else
        # macOS or Linux
        if curl -fsSL https://ollama.com/install.sh | sh; then
            INSTALL_SUCCESS=true
        fi
    fi
    
    if [ "$INSTALL_SUCCESS" = true ]; then
        echo "[SUCCESS] Ollama installed successfully."
        # Register the standard Windows path in the session if present to avoid session restarts
        if [[ -d "$HOME/AppData/Local/Programs/Ollama" ]]; then
            export PATH="$HOME/AppData/Local/Programs/Ollama:$PATH"
        fi
    else
        echo "[WARNING] Automatic installation failed. Skipping Self-Healing setup."
    fi
fi

if ! command -v ollama &> /dev/null; then
    echo "[INFO] Ollama is not available. Skipping Self-Healing setup."
else
    # Check if Ollama is running on port 11434
    if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
        echo "[SUCCESS] Ollama local service is active and running."
    else
        echo "[WARNING] Ollama local service is not running."
        echo "[SYSTEM] Attempting to launch Ollama in the background..."
        ollama serve & >/dev/null 2>&1
        
        printf "[SYSTEM] Waiting for Ollama service to respond "
        for i in {1..12}; do
            if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
                echo " [CONNECTED]"
                break
            fi
            printf "."
            sleep 5
        done
        
        if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
            echo " [TIMEOUT]"
            echo "[WARNING] Could not connect to Ollama. The pipeline will fall back to normal compilation mode."
        fi
    fi

    # If Ollama is running, check or pull the model
    if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
        if curl -s http://localhost:11434/api/tags | grep -q "qwen2.5-coder:7b"; then
            echo "[SUCCESS] Model qwen2.5-coder:7b is already pulled and cached."
        else
            echo "[SYSTEM] Model qwen2.5-coder:7b not detected. Pulling (this may take a few minutes)..."
            if ollama pull qwen2.5-coder:7b; then
                echo "[SUCCESS] Model qwen2.5-coder:7b pulled successfully."
            else
                echo "[WARNING] Failed to pull model qwen2.5-coder:7b. The pipeline will fall back to normal compilation mode."
            fi
        fi
    fi
fi
echo "--------------------------------------------------------------------"

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
