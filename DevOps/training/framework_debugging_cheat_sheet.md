# Senior Framework Debugging & Compilation Cheat Sheet

This document compiles common compilation, type-checking, and setup errors across React/MERN, Laravel, Spring Boot, and Django, highlighting senior-level solutions for Self-Healing models.

---

## 1. JS / MERN Stack (React, Express 5, Node.js, TypeScript)

### TypeScript Type Incompatibilities (TS2769, TS2339)
* **Problem:** `No overload matches this call` when querying Mongoose models (e.g. category matching Query types).
* **Fix:** Type-cast query parameters to `any` or match the interface schemas correctly:
  ```typescript
  // Before
  const items = await Product.find({ category: req.query.category });
  // After (safe type casting)
  const query: any = {};
  if (typeof req.query.category === 'string') {
    query.category = req.query.category;
  }
  const items = await Product.find(query);
  ```

### Express 5 Routing Compatibility
* **Problem:** Path-to-regexp v8 throws `Missing parameter name at index X` when using wildcards `*` in routes.
* **Fix:** Rename routes from `/*` to `/*wildcard` or `/:wildcard*` to conform to Express 5 syntax:
  ```javascript
  // Before
  app.get('/api/users/*', (req, res) => {});
  // After
  app.get('/api/users/*wildcard', (req, res) => {});
  ```

---

## 2. PHP / Laravel Stack

### Composer Dependency Mismatches
* **Problem:** Composer install fails due to PHP platform requirements (e.g. `composer.json requires php ^8.1 but your PHP version is 8.0`).
* **Fix:** Run installer with `--ignore-platform-reqs` flag, or update dependency versions in `composer.json`.

### Database Connection and PDO Configuration
* **Problem:** `PDOException: SQLSTATE[HY000] [2002] Connection refused`.
* **Fix:** Verify environment configurations. In `config/database.php` or `.env`, rewrite `DB_HOST=127.0.0.1` to the container host hostname (e.g. `DB_HOST=host.docker.internal` or dynamic docker network identifier).

---

## 3. Java Spring Boot

### Maven / Gradle Classpath & Dependency Conflicts
* **Problem:** `compileJava` or `mvn compile` fails with `package org.hibernate does not exist` or compilation class errors.
* **Fix:** Add missing dependencies in `pom.xml` (Maven) or `build.gradle` (Gradle), ensuring proper dependency scopes (e.g. `implementation` vs `provided`).

### Application Configuration Validation
* **Problem:** Spring Boot context fails to load with `BeanCreationException` or database driver configuration missing.
* **Fix:** Verify `src/main/resources/application.properties` or `application.yml` exposes correct active profiles and database URLs:
  ```properties
  spring.datasource.url=jdbc:postgresql://host.docker.internal:5432/preview_db
  spring.datasource.driver-class-name=org.postgresql.Driver
  ```

---

## 4. Python (Django & Flask)

### requirements.txt & Environment Setups
* **Problem:** `pip install -r requirements.txt` fails because of compilation requirements (e.g., `psycopg2` requires `pg_config`).
* **Fix:** Replace compiled dependencies with pre-built binaries (e.g. replace `psycopg2` with `psycopg2-binary` in `requirements.txt`).

### Migration Executions
* **Problem:** WSGI or server fails to boot because table migrations are unapplied or models are out of sync.
* **Fix:** Prepend execution scripts with schema checks and run migrations during initialization:
  ```bash
  python manage.py migrate --noinput
  ```
