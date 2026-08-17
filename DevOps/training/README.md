# Self-Healing Build Agent - Model Alignment Training Repository

This directory contains senior-level reference guides, few-shot prompt examples, and database administrator alignment guidelines for the Qwen-2.5-Coder model used in the Self-Healing Build Agent. 

These documents can be loaded as context or used to generate custom system prompts for alignment, helping fine-tune model healing reasoning on the 32 supported frameworks and database engines.

---

## Directory Contents

### 1. [Database Best Practices & DB Admin Guide](file:///d:/YASH/Final%20Year%20Projett/DevOps/training/database_best_practices.md)
* Comprehensive syntax and administrator rules for 9 database engines: **MySQL, PostgreSQL, MongoDB, SQLite, MariaDB, MS SQL Server, Oracle DB, Cassandra, and Redis**.
* Highlights connection troubleshooting, migration scripts, and schema declarations.

### 2. [Framework Debugging & Compilation Cheat Sheet](file:///d:/YASH/Final%20Year%20Projett/DevOps/training/framework_debugging_cheat_sheet.md)
* Standard compile-time error resolutions for major frameworks, focusing on:
  * **JS / MERN** (React, Express 5 routes, Node.js/Mongoose schemas)
  * **PHP / Laravel** (Composer, Artisan commands, PDO configurations)
  * **Java Spring Boot** (Maven/Gradle, Spring Data JPA classpaths)
  * **Python (Django / Flask)** (pip dependencies, wsgi/asgi entrypoints)

### 3. [Few-Shot Prompt Alignments](file:///d:/YASH/Final%20Year%20Projett/DevOps/training/few_shot_examples.md)
* Structured prompt-response examples mapping real compilation errors to correct XML-delimited `<patch>` healed output replacements.
