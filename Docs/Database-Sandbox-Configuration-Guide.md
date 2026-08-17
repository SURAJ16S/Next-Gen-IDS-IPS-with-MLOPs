# Database Sandbox Configuration Guide

This guide details the layout, checkbox logic, environment templates, and query instructions for all 9 supported database engines inside the DevOps Deployment Pipeline.

---

## 1. Checkbox Cascade Logic (Grandparent ➔ Parent ➔ Child)

The configuration form uses a synchronized hierarchical state transition scheme for its parameters to guarantee pipeline stability:

```
[Provision Containers (Grandparent)]
               │
               ▼
   [Custom DB Init (Parent)]
               │
               ▼
      [Smart Seeding (Child)]
```

### State Synchronization Rules:
1. **Grandparent Toggled Off:** Automatically clears and disables the Parent and Child checkboxes (collapsing the configuration block).
2. **Parent Toggled On:** Automatically ticks the Grandparent checkbox (as initialization requires a container to run on).
3. **Parent Toggled Off:** Automatically clears the Child checkbox.
4. **Child Toggled On:** Automatically ticks **both** the Parent and Grandparent checkboxes.
5. **Child Toggled Off:** Grandparent and Parent checkboxes remain checked (unchanged).

---

## 2. Database Engines & Configuration Reference

Here is the reference table of settings to select in the **Upload & Configure Project** form:

| Database Engine | Sandbox Type | Host Variable | Port Variable | Default Database/Schema | SQLite File Mode |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MySQL** | Docker Container | `DB_HOST` | `DB_PORT` (`3306`) | `preview_db` | N/A |
| **PostgreSQL** | Docker Container | `DB_HOST` | `DB_PORT` (`5432`) | `preview_db` | N/A |
| **MongoDB** | Docker Container | `MONGODB_URI` | `27017` | `preview_db` | N/A |
| **SQLite** | Local File | N/A | N/A | `preview_db.sqlite` | **Enabled** (Read/written directly in workspace) |
| **MariaDB** | Docker Container | `MARIADB_HOST` | `MARIADB_PORT` (`3306`) | `preview_db` | N/A |
| **SQL Server** | Docker Container | `MSSQL_HOST` | `MSSQL_PORT` (`1433`) | `master` / `preview_db` | N/A |
| **Oracle** | Docker Container | `ORACLE_HOST` | `ORACLE_PORT` (`1521`) | `ORCL` (Service Name) | N/A |
| **Cassandra** | Docker Container | `CASSANDRA_HOST` | `CASSANDRA_PORT` (`9042`)| `preview_keyspace` | N/A |
| **Redis** | Docker Container | `REDIS_HOST` | `REDIS_PORT` (`6379`) | N/A (Key-Value) | N/A |

---

## 3. Config Presets & Environment Variables

When deploying, click the corresponding **Load Config Presets** button to auto-inject the correct environment keys.

### Presets Keys:

#### 💾 SQLite Preset
```env
PORT=3001
SQLITE_DB=preview_db.sqlite
JWT_SECRET=supersecret
```

#### 💠 MariaDB Preset
```env
PORT=3001
MARIADB_HOST=127.0.0.1
MARIADB_PORT=3306
MARIADB_USER=root
MARIADB_PASSWORD=
MARIADB_DB=preview_db
JWT_SECRET=supersecret
```

#### 🖲️ SQL Server Preset
```env
PORT=3001
MSSQL_HOST=127.0.0.1
MSSQL_PORT=1433
MSSQL_USER=sa
MSSQL_PASSWORD=YourStrongPassword123
MSSQL_DB=preview_db
JWT_SECRET=supersecret
```

#### 🅾️ Oracle DB Preset
```env
PORT=3001
ORACLE_HOST=127.0.0.1
ORACLE_PORT=1521
ORACLE_USER=system
ORACLE_PASSWORD=oracle
ORACLE_SERVICE=ORCL
JWT_SECRET=supersecret
```

#### 🌌 Cassandra Preset
```env
PORT=3001
CASSANDRA_HOST=127.0.0.1
CASSANDRA_PORT=9042
CASSANDRA_KEYSPACE=preview_keyspace
JWT_SECRET=supersecret
```

#### ❤️ Redis Preset
```env
PORT=3001
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
JWT_SECRET=supersecret
```

---

## 4. Interactive Terminal Query Reference

Once a deployment pipeline completes, verify connection states by running queries in the terminal panel:

### SQLite (SQL)
```sql
SELECT name FROM sqlite_master WHERE type='table';
SELECT * FROM users;
```

### MariaDB / MySQL (SQL)
```sql
SHOW TABLES;
SELECT * FROM users;
```

### SQL Server / MSSQL (SQL)
```sql
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';
SELECT * FROM users;
```

### Oracle Database (SQL)
```sql
SELECT table_name FROM user_tables;
SELECT * FROM users;
```

### Cassandra (NoSQL / CQL)
```sql
DESCRIBE KEYSPACES;
SELECT * FROM preview_keyspace.users;
```

### Redis (NoSQL / CLI commands)
```redis
KEYS *
HGETALL user:admin
```

### MongoDB (NoSQL)
```javascript
show collections;
db.users.find().toArray();
```
