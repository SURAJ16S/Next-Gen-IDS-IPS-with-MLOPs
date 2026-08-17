# Multi-Container Database Sandboxing

This document explains the architecture of the DevOps platform's automated multi-container database provisioning and isolated network routing features.

---

## 1. Overview

To prevent deployed apps from depending on host services (like a physical MySQL server or a global Apache instance), the platform dynamically detects requested databases, creates a private virtual network on the Docker daemon, spawns isolated database containers, and auto-wires the connections.

```
┌────────────────────────────────────────────────────────┐
│               Docker Bridge Network                    │
│                                                        │
│   ┌─────────────────┐             ┌────────────────┐   │
│   │  MERN/PHP App   │             │   MongoDB      │   │
│   │    Container    │────────────►│  Container     │   │
│   │                 │             │                │   │
│   └─────────────────┘             └────────────────┘   │
│            │                                           │
│            ▼                                           │
│   ┌─────────────────┐                                  │
│   │    Redis        │                                  │
│   │  Container     │                                  │
│   └─────────────────┘                                  │
└────────────────────────────────────────────────────────┘
```

---

## 2. Supported Database Engines

The platform automatically detects and spawns container instances for the following database categories:

| Category | Database | Docker Image | Default Port | Detection Trigger |
|---|---|---|---|---|
| **NoSQL** | MongoDB | `mongo:6.0` | `27017` | `mongodb://` or `MONGO` env keys |
| **SQL** | MySQL | `mysql:8.0` | `3306` | `mysql://` or `DB_CONNECTION=mysql` |
| **SQL** | PostgreSQL | `postgres:15-alpine` | `5432` | `postgres://` or `DB_CONNECTION=pgsql` |
| **NoSQL** | Redis | `redis:7.0-alpine` | `6379` | `redis://` or `REDIS` env keys |
| **Vector** | Qdrant | `qdrant/qdrant:latest` | `6333` | `QDRANT` env keys or URLs |
| **Vector** | Chroma | `chromadb/chroma:latest` | `8000` | `CHROMA` env keys or URLs |

---

## 3. Dynamic Provisioning Workflow

When a preview is initiated, `spawnPreview` carries out the following steps:

1. **Configuration Inspection:** The parser extracts variables from the `.env` file inside the deployment directory.
2. **Database Engine Detection:** Scans the keys and values against regex rules to identify database dependencies.
3. **Bridge Network Creation:** Spawns a dedicated Docker bridge network specific to the build job:
   ```bash
   docker network create devops-net-{jobId}
   ```
4. **Database Instantiation:** Pulls target images (if missing) and spins up headless database containers attached to the private network. Authentication settings are pre-configured to trust-mode so previews build without credential errors:
   * **PostgreSQL:** Starts with `POSTGRES_HOST_AUTH_METHOD=trust` and default database `preview_db`.
   * **MySQL:** Starts with `MYSQL_ALLOW_EMPTY_PASSWORD=yes` and database `preview_db`.
5. **Private Hostname Resolution:** Database containers are given predictable names within the network:
   * `devops-db-mongodb-{jobId}`
   * `devops-db-mysql-{jobId}`
   * `devops-db-postgres-{jobId}`
   * `devops-db-redis-{jobId}`

---

## 4. Automatic Environment URI Rewriting

Rather than requiring code changes or custom configuration files, the platform **rewrites database environment variables at runtime** before spawning the main container.

* **Connection String Mutation:** Any value containing `localhost` or `127.0.0.1` matched with a detected database's port is replaced with the container's private hostname.
  * *Example (MongoDB):* `MONGODB_URI=mongodb://localhost:27017/hotels` is dynamically translated to `MONGODB_URI=mongodb://devops-db-mongodb-{jobId}:27017/hotels`.
  * *Example (PostgreSQL):* `DATABASE_URL=postgres://127.0.0.1:5432/preview_db` becomes `DATABASE_URL=postgres://devops-db-postgres-{jobId}:5432/preview_db`.
* **Host Key Overrides:** Env keys containing `HOST` (like `DB_HOST` or `REDIS_HOST`) set to `localhost` are rewritten to point directly to the hostname of the database container (e.g. `DB_HOST=devops-db-mysql-{jobId}`).

---

## 5. Garbage Collection & Lifecycle Cleanup

When a user stops a preview (via UI or CLI) or deletes a deployment record, the platform runs garbage collection tasks to prevent orphaned resources from cluttering the Docker daemon:
1. Shuts down and removes all matching database containers (`devops-db-{dbType}-{jobId}`).
2. Removes the virtual bridge network (`devops-net-{jobId}`).
This keeps ports and system memory completely clear.

---

## 6. PHP Database Driver Autoinjection

By default, base PHP Docker CLI images (like `php:8.2-cli`) do not package database drivers in order to keep image footprints small. This results in runtime errors when vanilla PHP applications try to connect to databases (e.g. `Call to undefined function mysqli_connect()`).

To solve this automatically without requiring developer-side container changes, the platform:
1. Detects if the framework is `php`.
2. Chains a pre-install command in the preview container entrypoint:
   ```bash
   docker-php-ext-install mysqli pdo_mysql && php -S 0.0.0.0:${PORT} ...
   ```
3. This dynamically compiles and registers the database drivers in ~8 seconds at startup, enabling seamless database connectivity out-of-the-box.

---

## 7. Automated Database Seeding

To make previews immediately testable without requiring manual user terminal intervention, the platform incorporates an **Automated Database Seeding Engine**:

1. **SQL File Detection:** During startup, the platform recursively scans the workspace directory for any `.sql` schema files (skipping `node_modules`, `vendor`, and `.git` folders).
2. **Streamed Stdin Import:** If a matching container database (MySQL or PostgreSQL) is active, the platform streams the SQL content directly into the running client command (`mysql -u root` or `psql -U postgres`) inside the container using Docker's stream execution API.
3. **Seeding Framework Hooks:**
   * **Node/MERN:** If `package.json` contains a `seed` or `db:seed` script, it is run inside the application container before launching.
   * **Laravel:** Triggers `php artisan migrate --force --seed` if artisan scripts are present.
   * **Django:** Automatically executes database migrations and creates a default superuser account (`admin` / `admin123`) if none exists.
