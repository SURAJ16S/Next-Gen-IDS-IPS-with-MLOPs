# Hostinger VPS Production Deployment & Architecture Migration Guide

This guide details how to migrate our local sandboxed DevOps and orchestrator platform to a **Hostinger VPS** (running Ubuntu 22.04 LTS), configuring wildcard DNS routing, container sandboxing, and enterprise observibility sidecars (Prometheus, Grafana, Vault, RabbitMQ).

---

## 1. Hostinger VPS Hardware Recommendation

Since your laptop has an i7-14700HX with 16GB RAM, we want to select a Hostinger VPS plan that handles compilation and sandboxing smoothly:
*   **Recommended Plan:** **KVM 2** (2 vCPUs, 4GB RAM, 50GB NVMe) or **KVM 4** (4 vCPUs, 8GB RAM, 100GB NVMe).
*   **Operating System:** **Ubuntu 22.04 LTS (64-bit)** (Clean install).

---

## 2. Dynamic Wildcard DNS Setup

To allow the orchestrator to launch and serve previews dynamically on their own addresses (e.g. `http://3001.sandbox.yourdomain.com`), configure your domain's DNS zone inside Hostinger or Cloudflare:

1.  **A Record:** Name = `sandbox`, Value = `<Your-VPS-IP-Address>`
2.  **Wildcard A Record:** Name = `*.sandbox`, Value = `<Your-VPS-IP-Address>`

This ensures any subdomain like `3001.sandbox.yourdomain.com` resolves directly to your Hostinger VPS.

---

## 3. Hostinger Production Architecture Setup

We will run the main application stack (Frontend, Backend, MongoDB) using Docker Compose, mounting the host's Docker socket `/var/run/docker.sock` to the backend. This allows the backend to launch sandboxed preview containers directly on the VPS host system (known as the *Docker-out-of-Docker / DooD* pattern).

### A. Install Docker and Docker Compose on the VPS
Connect to your VPS via SSH and run:
```bash
# Update OS packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt install docker-compose-plugin -y
```

### B. Production `docker-compose.yml`
Create a directory `/opt/devops-platform/` and write the following configuration:
```yaml
version: '3.8'

services:
  database:
    image: mongo:6.0
    container_name: devops-mongodb
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    networks:
      - devops-net

  backend:
    image: your-dockerhub-username/devops-backend:latest
    container_name: devops-backend
    restart: unless-stopped
    environment:
      - PORT=5000
      - MONGO_URI=mongodb://database:27017/devops
      - JWT_SECRET=your-production-jwt-key
      - NODE_ENV=production
    volumes:
      # Mount Host Docker daemon to spawn sandboxed previews
      - /var/run/docker.sock:/var/run/docker.sock
      # Persist builds and artifacts on VPS disk
      - /opt/devops-platform/DevOps:/workspace/DevOps
    depends_on:
      - database
    networks:
      - devops-net

  frontend:
    image: your-dockerhub-username/devops-frontend:latest
    container_name: devops-frontend
    restart: unless-stopped
    depends_on:
      - backend
    networks:
      - devops-net

networks:
  devops-net:
    name: devops-net

volumes:
  mongo-data:
```

---

## 4. Wildcard NGINX Reverse Proxy & SSL Setup

We will configure NGINX on the VPS host to:
1. Route `sandbox.yourdomain.com` to the frontend react portal.
2. Route API calls to the backend.
3. **Dynamically route** any subdomain `<port>.sandbox.yourdomain.com` to its corresponding running container port without needing a reload or configuration changes!

### A. Install NGINX on VPS Host
```bash
sudo apt install nginx -y
```

### B. Configure Dynamic Routing
Create NGINX configuration at `/etc/nginx/sites-available/devops-platform`:
```nginx
# 1. Main Web Panel and API Routing
server {
    listen 80;
    server_name sandbox.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000; # Points to Frontend container port
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://127.0.0.1:5000; # Points to Backend container port
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}

# 2. Dynamic Wildcard Subdomain Routing for Previews
server {
    listen 80;
    server_name ~^(?<port>\d+)\.sandbox\.yourdomain\.com$;

    location / {
        # Dynamically forward requests to localhost at the parsed subdomain port number
        proxy_pass http://127.0.0.1:$port;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}
```
Link and enable the config:
```bash
sudo ln -s /etc/nginx/sites-available/devops-platform /etc/nginx/sites-enabled/
sudo systemctl restart nginx
```

### C. Wildcard Let's Encrypt SSL Activation
Install certbot and request a wildcard certificate:
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d sandbox.yourdomain.com -d *.sandbox.yourdomain.com
```

---

## 5. Integrating Enterprise Sidecars (Observability, Secrets, MQ)

Because your Hostinger VPS runs Ubuntu natively, you can easily launch the remaining DevOps sidecars as sibling containers inside our `docker-compose.yml`:

### 1. Observability Sidecars (Prometheus & Grafana)
Add these to `docker-compose.yml` to collect VPS/Container metrics:
```yaml
  prometheus:
    image: prom/prometheus:latest
    container_name: devops-prometheus
    volumes:
      - /opt/devops-platform/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    networks:
      - devops-net

  grafana:
    image: grafana/grafana:latest
    container_name: devops-grafana
    ports:
      - "3000:3000"
    networks:
      - devops-net
```

### 2. Secrets Management (HashiCorp Vault)
Add Vault to store encryption keys and API keys:
```yaml
  vault:
    image: hashicorp/vault:latest
    container_name: devops-vault
    environment:
      - VAULT_DEV_ROOT_TOKEN_ID=vps-secure-token
    ports:
      - "8200:8200"
    networks:
      - devops-net
```

### 3. Event Bus (RabbitMQ)
Add RabbitMQ sidecar for microservices messaging:
```yaml
  rabbitmq:
    image: rabbitmq:3-management
    container_name: devops-rabbitmq
    ports:
      - "5672:5672"
      - "15672:15672"
    networks:
      - devops-net
```
