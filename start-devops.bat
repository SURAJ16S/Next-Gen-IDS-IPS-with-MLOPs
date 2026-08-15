@echo off
title DevOps Local Stack Orchestrator
color 0B
cls

if "%1"=="down" goto stop_flow
if "%1"=="stop" goto stop_flow
goto start_flow

:stop_flow
echo ====================================================================
echo                   DevOps Local Sidecars Orchestrator
echo ====================================================================
echo [SYSTEM] Stopping all DevOps sidecar containers...

rem Add user AppData bin path to local session PATH if docker is not registered globally
where docker >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%USERPROFILE%\AppData\Local\Programs\DockerDesktop\resources\bin" (
        set "PATH=%USERPROFILE%\AppData\Local\Programs\DockerDesktop\resources\bin;%PATH%"
    )
)

cd DevOps
docker compose -f docker-compose-devops.yml down
cd ..
echo [SUCCESS] All DevOps services stopped.
exit /b 0

:start_flow
echo ====================================================================
echo                   DevOps Local Sidecars Orchestrator
echo ====================================================================
echo [SYSTEM] Checking Docker status...

rem Add user AppData bin path to local session PATH if docker is not registered globally
where docker >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%USERPROFILE%\AppData\Local\Programs\DockerDesktop\resources\bin" (
        set "PATH=%USERPROFILE%\AppData\Local\Programs\DockerDesktop\resources\bin;%PATH%"
    )
)

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Docker daemon is not running!
    echo [SYSTEM] Attempting to launch Docker Desktop...
    
    set "DOCKER_EXE="
    if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
        set "DOCKER_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe"
    ) else if exist "%USERPROFILE%\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe" (
        set "DOCKER_EXE=%USERPROFILE%\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
    ) else if exist "%USERPROFILE%\AppData\Local\Programs\Docker Desktop\Docker Desktop.exe" (
        set "DOCKER_EXE=%USERPROFILE%\AppData\Local\Programs\Docker Desktop\Docker Desktop.exe"
    )

    if defined DOCKER_EXE (
        start "" "%DOCKER_EXE%"
        <nul set /p =[SYSTEM] Waiting for Docker daemon to initialize (this takes 30-60s) 
        
        :wait_loop
        <nul set /p =.
        timeout /t 5 /nobreak >nul
        docker info >nul 2>&1
        if %errorlevel% neq 0 goto wait_loop
        echo  [CONNECTED]
    ) else (
        echo [ERROR] Docker Desktop could not be found in standard or AppData locations.
        echo Please launch Docker Desktop manually and run this script again.
        pause
        exit /b 1
    )
)

echo [SUCCESS] Docker daemon is connected and active.
echo [SYSTEM] Starting all DevOps sidecar containers...
echo --------------------------------------------------------------------

cd DevOps
docker compose -f docker-compose-devops.yml up -d
if %errorlevel% neq 0 (
    echo [ERROR] Failed to start Docker Compose services.
    cd ..
    pause
    exit /b 1
)
cd ..

echo --------------------------------------------------------------------
echo [SUCCESS] All DevOps services launched successfully!
echo ====================================================================
echo.
echo   - DevOps Web Portal   : http://localhost:5173
echo   - Local Database (Mongo): mongodb://localhost:27017
echo   - Prometheus Metrics  : http://localhost:9090
echo   - Grafana Dashboards  : http://localhost:3000
echo   - HashiCorp Secrets   : http://localhost:8200 (Token: my-secure-token)
echo   - RabbitMQ Management : http://localhost:15672 (guest/guest)
echo   - Private Registry    : http://localhost:5001
echo.
echo ====================================================================
echo [INFO] Run "docker compose -f DevOps/docker-compose-devops.yml down" to stop.
echo ====================================================================
pause
