# Sandbox Resource Consumption Report

This report provides a comparative analysis of the system resource allocation (RAM and Disk Storage) between the **Web Application Build/Runtime Containers** (Python Flask, Node.js Express, Java Spring Boot) and their corresponding **Database Sandbox Containers** (MySQL, PostgreSQL, MongoDB, SQLite, MariaDB, SQL Server, Oracle, Cassandra, Redis).

---

## 1. Executive Summary

In a multi-container local sandboxing environment, database containers typically dwarf application runtime containers in resource consumption. Heavyweight enterprise databases (Oracle, MS SQL Server, Cassandra) consume significantly more RAM and storage than lightweight databases (Redis, Postgres) or embedded options (SQLite).

### Resource Distribution Insights:
*   **Lightest Stack:** `Python Flask + SQLite` (No database container overhead; SQLite runs directly in-process).
*   **Most Balanced Stack:** `Node.js + PostgreSQL` (Both runtimes consume moderate memory and storage, close to a **1:1** ratio).
*   **Heaviest Stack:** `Python Flask + Oracle Database` (Database-to-App memory consumption ratio exceeds **30:1**).

---

## 2. Resource Footprint Profiles

The following baseline metrics represent average idle/startup states of sandbox containers in Docker.

### Web Application Runtimes:
*   **Python (Flask):** 
    *   *RAM:* **30MB - 50MB**
    *   *Storage (Image + Code):* **150MB - 180MB** (based on `python:3.10-slim`)
*   **Node.js (Express / MERN):** 
    *   *RAM:* **60MB - 90MB**
    *   *Storage (Image + node_modules):* **350MB - 500MB** (based on `node:18-slim`)
*   **Java (Spring Boot):** 
    *   *RAM:* **250MB - 400MB** (JVM startup overhead)
    *   *Storage (Image + build jar):* **300MB - 400MB** (based on `eclipse-temurin:17-jre`)

### Database Engines (Idle / Startup):
*   **Redis:** *RAM:* **5MB - 15MB** | *Storage:* **30MB** (Highly optimized C engine)
*   **SQLite:** *RAM:* **<10MB** | *Storage:* **<1MB** (Runs inside App memory space)
*   **PostgreSQL:** *RAM:* **50MB - 120MB** | *Storage:* **250MB** (Postgres Alpine image)
*   **MariaDB:** *RAM:* **100MB - 180MB** | *Storage:* **400MB**
*   **MySQL:** *RAM:* **120MB - 220MB** | *Storage:* **550MB** (Allocates InnoDB buffer pools)
*   **MongoDB:** *RAM:* **150MB - 300MB** | *Storage:* **700MB** (Allocates WiredTiger cache)
*   **Cassandra:** *RAM:* **600MB - 1.0GB** | *Storage:* **400MB** (Java JVM-based NoSQL)
*   **SQL Server (MSSQL):** *RAM:* **800MB - 1.2GB** | *Storage:* **1.6GB** (Requires high start RAM)
*   **Oracle Database:** *RAM:* **1.0GB - 1.5GB** | *Storage:* **2.5GB** (Slim Express Edition)

---

## 3. Technology Stack Comparison & Consumption Ratios

Below is a detailed matrix of stack combinations, outlining the **Database-to-App (DB:App)** resource consumption ratios.

### Memory (RAM) Allocation Ratios

| Combination Stack | App RAM | DB RAM | DB:App Ratio | Severity Note |
| :--- | :--- | :--- | :--- | :--- |
| **Flask + SQLite** | 40 MB | 0 MB (In-App) | **0 : 1** (Embedded) | Extremely lightweight |
| **Flask + Redis** | 40 MB | 10 MB | **0.25 : 1** | Lightweight |
| **MERN + PostgreSQL** | 75 MB | 80 MB | **1.07 : 1** | Balanced |
| **MERN + MySQL** | 75 MB | 180 MB | **2.40 : 1** | Moderate |
| **MERN + MongoDB** | 75 MB | 225 MB | **3.00 : 1** | Moderate |
| **Spring Boot + MongoDB**| 350 MB | 225 MB | **0.64 : 1** | High App usage |
| **MERN + Cassandra** | 75 MB | 800 MB | **10.67 : 1** | Heavy Database |
| **Flask + SQL Server** | 40 MB | 1000 MB | **25.00 : 1** | Extremely Heavy DB |
| **Flask + Oracle DB** | 40 MB | 1200 MB | **30.00 : 1** | Extremely Heavy DB |
| **Spring Boot + Oracle** | 350 MB | 1200 MB | **3.43 : 1** | Overall Heavy Stack |

### Storage (Disk) Footprint Ratios

| Combination Stack | App Disk | DB Disk | DB:App Ratio | Severity Note |
| :--- | :--- | :--- | :--- | :--- |
| **Flask + SQLite** | 160 MB | 0 MB (In-App) | **0 : 1** (Embedded) | Minimal footprint |
| **Flask + Redis** | 160 MB | 30 MB | **0.19 : 1** | Compact |
| **MERN + PostgreSQL** | 450 MB | 250 MB | **0.55 : 1** | App-heavy storage |
| **MERN + MariaDB** | 450 MB | 400 MB | **0.88 : 1** | Balanced |
| **MERN + MySQL** | 450 MB | 550 MB | **1.22 : 1** | Balanced |
| **MERN + MongoDB** | 450 MB | 700 MB | **1.55 : 1** | Moderate |
| **Spring Boot + MSSQL** | 350 MB | 1600 MB | **4.57 : 1** | Heavy DB storage |
| **Flask + MSSQL** | 160 MB | 1600 MB | **10.00 : 1** | Heavy DB storage |
| **Flask + Oracle DB** | 160 MB | 2500 MB | **15.63 : 1** | Extremely Heavy DB |
| **Spring Boot + Oracle** | 350 MB | 2500 MB | **7.14 : 1** | Heavy Stack |

---

## 4. Key Takeaways & Recommendations

1. **Local Sandbox Hosting Thresholds:**
   * SQLite and Redis are suitable for low-resource dev machines.
   * Running enterprise databases (Oracle, MSSQL, Cassandra) requires a minimum host machine size of **16GB RAM** (as starting both the IDE, OS, app builder, and DB container can allocate upwards of **4GB - 6GB** memory instantly).
2. **SQLite Performance Advantage:**
   * SQLite runs inside the same process as the Flask application thread, eliminating inter-container communication ports, docker virtual network latency, and memory overhead.
3. **WiredTiger (MongoDB) & InnoDB (MySQL) Cache Control:**
   * To lower memory usage of database containers during dev, append size-limit flags to container launch scripts (e.g. `docker run -m 512m` or configure custom config templates setting `innodb_buffer_pool_size=64M`).
