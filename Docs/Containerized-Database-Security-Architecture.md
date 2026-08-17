# Containerized Database Security & Networking Architecture

This document details the architectural best practices, network separation designs, and security policies for isolating database containers within private subnets in modern microservices and production cloud environments.

---

## 1. Multi-Tier Container Isolation

Running the web server runtime and database engine inside separate container instances is a core architectural requirement.

### Advantages of Container Disaggregation:
*   **Scale Independence:** App containers can scale dynamically horizontally via auto-scaling policies (e.g. AWS ECS, Kubernetes HPA) to handle traffic spikes. The database remains a single, high-performance clustered stateful tier, avoiding data splitting or replication conflicts.
*   **Decoupled Upgrades:** Application builds (code modifications, JS/Python package updates) can deploy continuously (CI/CD) without affecting the database uptime. Database engine patches or schema migrations run isolated, reducing overall risk.
*   **Fault Isolation:** If an application route runs out of memory (OOM) or triggers a runtime exception, only that app container restarts. The database engine remains active, preventing transactions from being interrupted or corrupted.

---

## 2. Multi-Tier Network Design (DMZ vs. Private Subnet)

In cloud network designs (AWS VPC, Azure VNet, GCP VPC), containers are mapped to specific network subnets based on their exposure risk.

```
                  [ Public Internet ]
                           │
                           ▼ (Port 443 / HTTPS)
┌─────────────────────────────────────────────────────────┐
│ Public Subnet (DMZ Tier)                                │
│   - Internet Gateway Enabled                            │
│   - Application Load Balancer (ALB)                     │
│   - Web Application Containers (Public IP)              │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼ (Internal DB Port: 3306/5432)
┌─────────────────────────────────────────────────────────┐
│ Private Subnet (Data Tier)                              │
│   - NO Public IP / Internet Gateway route               │
│   - Stateful Database Containers (Internal IP only)      │
│   - Outbound internet via NAT Gateway (for updates only)│
└─────────────────────────────────────────────────────────┘
```

### Subnet Definitions:
1.  **Public Subnet (DMZ):** Resides at the edge. Houses load balancers, proxies, and frontend application containers. These instances possess public IP addresses and can routing traffic to/from the internet.
2.  **Private Subnet (Isolated Data Tier):** Houses database containers, caching layers, and backend queuing systems. These instances possess only **private IP addresses** (e.g., `10.0.2.0/24`) and have no routes to the Internet Gateway.

---

## 3. Network Access Control Policies (Defense in Depth)

Placing database containers in a private subnet is supplemented by strict Layer 3 and Layer 4 firewalls.

### Inbound Firewall Rules (Security Groups):
*   Database security groups must reject all incoming connections except for the specific IP addresses or Security Group IDs belonging to the **Web Application Container tier**.
*   All admin tools (e.g. phpMyAdmin, MongoDB Express, PgAdmin) should be disabled in production or strictly mapped behind internal interfaces.

### Outbound Firewall Rules:
*   Database containers should be restricted from initiating outbound internet connections, except for explicit IP blocks (e.g. OS patching mirrors) routed through a **NAT Gateway**.

---

## 4. Secure Administration & Query Management

To monitor or manage database sandboxes inside a private subnet, administrators must use secure proxy access.

### 1. Bastion Host (Jump Box)
*   A lightweight, hardened Linux instance resides in the Public Subnet (DMZ).
*   Administrators SSH into the Bastion host using SSH Key Pairs, then establish an encrypted **SSH Local Port Forwarding** tunnel to access the private database port:
    ```bash
    ssh -i admin-key.pem -L 3307:private-db-ip:3306ec2-user@bastion-public-ip
    ```
    This securely maps the private port `3306` inside the subnet to local port `3307` on the administrator's workstation over SSH.

### 2. Client VPN / AWS Client VPN
*   Administrators connect via an OpenVPN-based client profile.
*   Once connected, the admin workstation becomes a virtual node inside the internal VPC, allowing secure querying of the database container using internal private IP addresses directly.
