# Senior Database Administrator Guide & Best Practices

This guide compiles administrator-level guidelines and configuration troubleshooting for 9 database engines to assist the Self-Healing agent in diagnosing database-related compilation and setup errors.

---

## 1. SQLite
* **Configuration:** SQLite is serverless; ensure the connection string points to a writable local file directory path.
* **Troubleshooting:**
  * Avoid `SQLITE_BUSY` errors by ensuring database connections are closed or pooling is limited to single write channels.
  * Correct datatype declarations: SQLite has dynamic typing (TEXT, NUMERIC, INTEGER, REAL, BLOB).

## 2. MariaDB / MySQL
* **Host configuration:** When containerized, ensure binds expose `0.0.0.0` (listen to all interfaces) instead of hardcoding `127.0.0.1` inside container environment variables.
* **Troubleshooting Syntax Errors:**
  * MariaDB supports standard SQL. Check for reserved keyword conflicts (e.g. escaping table/column names like `\`key\`` or `\`order\``).
  * Ensure correct syntax for UPSERT operations (e.g. `INSERT ... ON DUPLICATE KEY UPDATE`).

## 3. MS SQL Server (mssql)
* **Configuration:** Port defaults to `1433`. Requires accepting EULA via `ACCEPT_EULA=Y` when running in Docker containers.
* **Common Failures:**
  * Authentication: SQL Server defaults to SQL Authentication mixed mode. Verify that `SA_PASSWORD` matches complex password policy requirements.
  * Connection Strings: Ensure `encrypt=true;trustServerCertificate=true` is appended in development environments to avoid SSL negotiation errors.

## 4. Oracle Database (oracle)
* **Configuration:** Port defaults to `1521`. Needs environment setup pointing to correct SID/Service Name (e.g., `ORCL` or `FREE`).
* **Common Failures:**
  * Oracle SQL does not support `LIMIT / OFFSET` clauses in older versions (pre-12c). Replace with `ROWNUM` filtering or `OFFSET X ROWS FETCH NEXT Y ROWS ONLY`.
  * Ensure user roles and schema privileges (e.g. `GRANT CONNECT, RESOURCE TO username`) are part of initial seed scripts.

## 5. Cassandra (NoSQL Column Family)
* **Configuration:** Port defaults to `9042`. Clusters require seed node IPs to bootstrap successfully.
* **Common Failures:**
  * Keyspaces: Verify that the Keyspace creation uses appropriate replication factors:
    ```sql
    CREATE KEYSPACE my_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
    ```
  * Query Constraints: Cassandra CQL does not support joins or arbitrary `WHERE` clauses unless the columns are part of the primary key or `ALLOW FILTERING` is explicitly added.

## 6. Redis (In-Memory Key-Value Store)
* **Configuration:** Port defaults to `6379`.
* **Common Failures:**
  * Ensure connections use proper connection strings (e.g. `redis://default:password@host:6379`).
  * Verify memory allocation limit policy: when used as cache, configure `maxmemory-policy allkeys-lru` to prevent out of memory write failures.

## 7. MongoDB (Document NoSQL)
* **Configuration:** Port defaults to `27017`.
* **Common Failures:**
  * Query Casting: Ensure `ObjectId` values are parsed using `mongoose.Types.ObjectId(id)` or `new ObjectId(id)` rather than passing raw strings into match aggregations.
  * Cloud Atlas Limits: Free tier limits clusters to 500 collections. If exceeded, redirect to local instance.

## 8. PostgreSQL (Relational)
* **Configuration:** Port defaults to `5432`.
* **Common Failures:**
  * Ensure schema names are correctly mapped. Column names are case-sensitive if double-quoted.
  * Use proper UPSERT syntax: `INSERT INTO ... ON CONFLICT (id) DO UPDATE SET ...`.
