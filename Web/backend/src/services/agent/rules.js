const getStackRules = (techStack, deploymentId) => {
  const isPython = ['flask', 'django', 'fastapi', 'python'].some(s => techStack.includes(s));
  const isNode = ['mern', 'node', 'express', 'fastify', 'elysia', 'hono', 'koa', 'h3', 'nextjs', 'react', 'vue', 'svelte', 'angular', 'vite', 'nuxt', 'remix', 'astro', 'qwik', 'solidstart', 'analog', 'tanstack-start', 'nitro', 'blitz', 'redwood', 'marko', 'preact', 'static'].some(s => techStack.includes(s));
  const isGo = ['go', 'gin', 'fiber', 'echo'].some(s => techStack.includes(s));
  const isRuby = ['ruby', 'rails', 'sinatra'].some(s => techStack.includes(s));
  const isJava = ['java', 'spring', 'quarkus'].some(s => techStack.includes(s));
  const isRust = ['rust', 'cargo', 'axum'].some(s => techStack.includes(s));
  const isPhp = ['php', 'laravel', 'symfony'].some(s => techStack.includes(s));
  const isDotnet = ['dotnet', 'blazor', 'c#', 'csharp'].some(s => techStack.includes(s));
  const isDeno = ['deno', 'fresh'].some(s => techStack.includes(s));
  const isBun = ['bun'].some(s => techStack.includes(s));
  const isElixir = ['elixir', 'phoenix'].some(s => techStack.includes(s));

  let rule2Text = '';
  let rule7Text = '';
  let rule9Text = '';
  let rule11Text = '';
  let abilitiesExamples = '';

  if (isPython) {
    rule2Text = `RULE 2 — USE PYTHON FOR PYTHON PROJECTS:
  Python, python3, pip, pip3, and all Python packages (like psycopg2, pymongo, sqlalchemy, pgvector, etc.) ARE available in this container.
  All scripts and utilities (such as database seeders) MUST be written in Python and executed using: python3 script.py
  Do NOT write Node.js JavaScript scripts if it's a Python project. Use Python always.`;

    rule7Text = `RULE 7 — ENSURE PIP DEPENDENCIES:
  If a Python script fails due to a missing package (e.g. ModuleNotFoundError: No module named 'X'), run: <exec command="pip3 install X" /> or execute pip with python3 inside the container to install it, then retry.`;

    rule9Text = `RULE 9 — PYTHON DATABASE MODELS AND SEEDING:
  This project is a Python project.
  - Model/schema definitions are written in Python files (e.g., inside app.py, models.py, or models/ directory).
  - You MUST inspect these files using <exec command="cat path/to/models.py" /> to see the real table names, columns, and database relationships.
  - To seed the database, write a python seed script (e.g. <patch file="seed.py">) that imports the DB models or runs raw SQL queries (using psycopg2 for postgres, sqlite3 for sqlite, etc.) and executes it with: <exec command="python3 seed.py" />.
  - Connection options: Always use the proper environment variables or container database hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — READ PYTHON ERROR TRACEBACKS:
  When a python script execution fails, read the traceback to find the exact line and file that crashed. Inspect and patch the files accordingly.`;

    abilitiesExamples = `   - Read files: <exec command="cat app.py" />
   - Find files: <exec command="find . -name '*.py' -not -path '*/.venv/*'" />
   - Install packages: <exec command="pip3 install psycopg2" />
   - Run scripts: <exec command="python3 seed.py" />
3. TOKEN EFFICIENCY: For database seeding, create a standalone seed.py via <patch> and run it with <exec command="python3 seed.py" />.`;
  } else if (isNode) {
    rule2Text = `RULE 2 — NEVER USE PYTHON:
  Python, python3, pip, pip3, and all Python packages are NOT available in this container.
  All scripts MUST be written in plain JavaScript and run with: node script.js
  If you generate Python code, you are wrong. Use Node.js ALWAYS.`;

    rule7Text = `RULE 7 — ts-node IS NOT AVAILABLE:
  Do NOT run TypeScript files with ts-node. Always write plain JavaScript (.js) seed/utility scripts.`;

    rule9Text = `RULE 9 — MONOREPO DEPENDENCY PATHS:
  This project is a monorepo. Server-side packages (like mongoose, bcrypt, dotenv, etc.) are installed in the "server" directory.
  - ALWAYS write database seeds/utility scripts inside the "server" directory (e.g. <patch file="server/seed.js">) rather than the root directory.
  - ALWAYS run them from the root directory by specifying the subfolder path: <exec command="node server/seed.js" />.
  - If you run them at the root level, node will throw "Cannot find module 'mongoose'".
  - Database models inside this container workspace are located in the "server/dist/models/" directory (e.g., server/dist/models/User.js, server/dist/models/Product.js). ALWAYS read them from there.
  - ES MODULES TRANSLATION: The backend models (like User, Product, Category, etc.) are transpiled to CommonJS. They export their mongoose model as the default export. Therefore, when requiring these models in your CommonJS seed/utility scripts, you MUST append ".default" (e.g. const User = require('./dist/models/User').default;). If you omit ".default", calling methods on the model will throw a TypeError.
  - MIDDLEWARE BYPASS: If a model's pre-save hooks or middleware crash (for example, with "TypeError: next is not a function" during saves), you can bypass them by using raw MongoDB operations directly on the collection: e.g. await Model.collection.insertMany(data). Note that if you bypass pre-save hooks, you must hash passwords manually using bcrypt (const bcrypt = require('bcryptjs'); const hashed = await bcrypt.hash(password, 12);) before inserting.`;

    rule11Text = `RULE 11 — READ THE TOP OF ERROR STACK TRACES:
  When a node script execution fails with a SyntaxError, TypeError, or similar crash, look at the VERY FIRST file mentioned at the top of the "at Object.<anonymous>" calls in the stack trace. That is the file that contains the crash, not necessarily the seed script itself. Inspect and patch the actual file where the crash occurred to resolve the problem.`;

    abilitiesExamples = `   - Read files: <exec command="cat server/models/Product.js" />
   - Find files: <exec command="find . -name '*.js' -path '*/models/*' -not -path '*/node_modules/*'" />
   - Install packages: <exec command="npm install mongoose" />
   - Run scripts: <exec command="node seed.js" />
3. TOKEN EFFICIENCY: For database seeding, create a standalone seed.js via <patch> and run it with <exec command="node seed.js" />.`;
  } else if (isGo) {
    rule2Text = `RULE 2 — USE GO RUNTIME FOR GO PROJECTS:
  Go (go) is available in this container.
  All scripts, seeders, or database utility scripts MUST be written in Go or raw SQL/NoSQL statements and executed with: go run script.go (or similar commands).
  Do NOT use Python or JavaScript for scripting in a Go project.`;

    rule7Text = `RULE 7 — ENSURE GO MODULE DEPENDENCIES:
  If a command fails due to missing dependencies, run: <exec command="go get X" /> or <exec command="go mod tidy" /> to fetch required modules.`;

    rule9Text = `RULE 9 — GO DATABASE SCHEMAS AND SEEDING:
  This project is a Go project.
  - Inspect struct definitions and models inside \`.go\` files to see column/table layouts.
  - To seed the database, write a Go script (e.g. <patch file="seed.go">) that connects to the database container using Rule 3 hostnames (never localhost) and inserts test records, then run it with: <exec command="go run seed.go" />.`;

    rule11Text = `RULE 11 — ANALYZE GO COMPILATION ERRORS:
  If Go run or build fails, read the compiler output messages. Inspect the files, patch syntax/type errors, and re-run.`;

    abilitiesExamples = `   - Read files: <exec command="main.go" />
   - Find files: <exec command="find . -name '*.go'" />
   - Install packages: <exec command="go get github.com/lib/pq" />
   - Run scripts: <exec command="go run seed.go" />
3. TOKEN EFFICIENCY: For database seeding, create a standalone seed.go via <patch> and run it with <exec command="go run seed.go" />.`;
  } else if (isRuby) {
    rule2Text = `RULE 2 — USE RUBY RUNTIME FOR RUBY PROJECTS:
  Ruby is available in this container.
  All scripts, seeders, or database utility scripts MUST be written in Ruby and executed with: ruby script.rb (or rails console/tasks).
  Do NOT use Python or JavaScript for scripting in a Ruby project.`;

    rule7Text = `RULE 7 — ENSURE GEM DEPENDENCIES:
  If a Ruby command fails due to missing gem packages, run: <exec command="bundle install" /> or <exec command="gem install X" /> to fetch required dependencies.`;

    rule9Text = `RULE 9 — RUBY/RAILS DATABASE SCHEMAS AND SEEDING:
  This project is a Ruby project.
  - Models are typically located in app/models/ or other ruby files.
  - To seed the database, write a Ruby script (e.g., <patch file="seed.rb">) or use Rails seeds and run them with: <exec command="ruby seed.rb" /> or <exec command="rails db:seed" />.
  - Always use the proper environment variables or database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE RUBY ERRORS:
  Read the Ruby exception stack trace carefully. Identify the failing line and file, apply patches to fix, and re-run.`;

    abilitiesExamples = `   - Read files: <exec command="cat config/database.yml" />
   - Find files: <exec command="find . -name '*.rb'" />
   - Install packages: <exec command="bundle install" />
   - Run scripts: <exec command="ruby seed.rb" /> or <exec command="bundle exec rails db:seed" />
3. TOKEN EFFICIENCY: For database seeding, write seed.rb or rails tasks via <patch> and run it.`;
  } else if (isJava) {
    rule2Text = `RULE 2 — USE JAVA ENVIRONMENT:
  Java, Maven (global 'mvn' command or './mvnw'), and Gradle ('gradle' or './gradlew') are available in this container.
  All scripts, seeders, or database utilities should be run using Maven, Gradle, or directly via pre-compiled jar/SQL scripts.
  Do NOT use Python or JavaScript for database seeding in a Java project.`;

    rule7Text = `RULE 7 — BUILD DEPENDENCIES:
  Add missing dependencies to pom.xml (for Maven) or build.gradle (for Gradle) and rebuild the project if needed.`;

    rule9Text = `RULE 9 — JAVA/SPRING DATABASE SCHEMAS AND SEEDING:
  This project is a Java project (usually Spring Boot).
  - You MUST first locate and inspect existing database tables (via <exec command="PGPASSWORD=postgres psql -h devops-db-postgres-${deploymentId} -U postgres -d preview_db -c '\\dt'" />) and Java JPA/Hibernate entity classes (classes annotated with @Entity) or application.properties to find the exact database schema, tables, and column names.
  - If a user asks for "products" or "items", check if an entity/table (like 'items') already exists before trying to create a new entity.
  - In modern Spring Boot, always use 'jakarta.persistence.*' imports (e.g. jakarta.persistence.Entity, jakarta.persistence.Id, etc.), NOT deprecated 'javax.persistence.*'.
  - To seed the database, write a raw SQL seed script (e.g. <patch file="seed.sql">) containing INSERT statements.
  - Execute the seed script against the Postgres database container using:
    <exec command="PGPASSWORD=postgres psql -h devops-db-postgres-${deploymentId} -U postgres -d preview_db -f seed.sql" /> (or mysql equivalents).
  - Note: ALWAYS set the database password (e.g. PGPASSWORD=postgres) inline to prevent terminal prompts that hang execution.
  - Connection options: Always use the database container hostname as defined in Rule 3 (never use localhost).
  - REBUILDING AND RECOMPILING JAVA CODE CHANGES: If you modify Java source code or pom.xml, you MUST rebuild the application inside the container using:
    <exec command="mvn clean package dependency:copy-dependencies -DskipTests" /> (or gradle equivalent).
    Do NOT ask the user to install Maven, clean, compile, or run the project. You must do this yourself in the container.`;

    rule11Text = `RULE 11 — ANALYZE JAVA COMPILATION ERRORS:
  Read Java/Maven/Gradle build errors. Trace the compilation exceptions, patch files, and rebuild.`;

    abilitiesExamples = `   - Read files: <exec command="cat src/main/resources/application.properties" />
   - Find files: <exec command="find . -name '*.java'" />
   - Check DB tables: <exec command="PGPASSWORD=postgres psql -h devops-db-postgres-${deploymentId} -U postgres -d preview_db -c '\\dt'" />
   - Compile/Package project: <exec command="mvn clean package dependency:copy-dependencies -DskipTests" /> (or gradle equivalent)
   - Run SQL seed: <exec command="PGPASSWORD=postgres psql -h devops-db-postgres-${deploymentId} -U postgres -d preview_db -f seed.sql" /> or mysql equivalents
3. TOKEN EFFICIENCY: Write SQL or java seed classes via <patch> and run them.`;
  } else if (isPhp) {
    rule2Text = `RULE 2 — USE PHP ENVIRONMENT:
  PHP and Composer are available in this container.
  All scripts, seeders, or database utilities MUST be written in PHP and run with: php script.php (or artisan commands).
  Do NOT use Python or JavaScript for database seeding in a PHP project.`;

    rule7Text = `RULE 7 — PHP DEPENDENCIES:
  If a command fails due to missing PHP packages, run: <exec command="composer install" /> or <exec command="composer require X" /> to install them.`;

    rule9Text = `RULE 9 — PHP DATABASE SCHEMAS AND SEEDING:
  This project is a PHP/Laravel project.
  - Inspect PHP model classes (in app/Models/ or Entity/) or migration files to understand database layout.
  - To seed the database, run: <exec command="php artisan db:seed" /> or write a PHP script (e.g. <patch file="seed.php">) and execute it with: <exec command="php seed.php" />.
  - Connection options: Always use the proper environment variables or database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE PHP STACK TRACES:
  Read PHP compilation or runtime tracebacks, locate the file and line, apply patches, and re-run.`;

    abilitiesExamples = `   - Read files: <exec command="cat .env" />
   - Find files: <exec command="find . -name '*.php'" />
   - Run seed: <exec command="php artisan db:seed" /> or <exec command="php seed.php" />
3. TOKEN EFFICIENCY: Create seed files or database tasks via <patch> and execute them.`;
  } else if (isDotnet) {
    rule2Text = `RULE 2 — USE .NET RUNTIME:
  The .NET CLI (dotnet) is available in this container.
  All scripts, seeders, or database utilities must be run using dotnet commands or raw SQL scripts.
  Do NOT use Python or JavaScript for database seeding in a C#/.NET project.`;

    rule7Text = `RULE 7 — C# NUGET DEPENDENCIES:
  Add missing C# packages using: <exec command="dotnet add package X" /> inside the project directory.`;

    rule9Text = `RULE 9 — .NET DATABASE SCHEMAS AND SEEDING:
  This project is a C#/.NET project.
  - Inspect DBContext and model classes to see the database schema.
  - To seed the database, write an Entity Framework migration / seeding code, or execute SQL scripts on the database container.
  - Connection options: Always use the database container hostname as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE .NET COMPILER ERRORS:
  Trace compiler errors or exceptions from dotnet run/build, patch C# source files, and run again.`;

    abilitiesExamples = `   - Read files: <exec command="cat appsettings.json" />
   - Find files: <exec command="find . -name '*.cs'" />
   - Run project: <exec command="dotnet run" />
3. TOKEN EFFICIENCY: Create migration seeding or SQL script via <patch> and apply it.`;
  } else if (isDeno || isBun) {
    const runtimeName = isDeno ? 'Deno' : 'Bun';
    const runtimeCmd = isDeno ? 'deno' : 'bun';
    rule2Text = `RULE 2 — USE ${runtimeName.toUpperCase()} RUNTIME:
  The ${runtimeName} runtime is available in this container.
  All scripts, seeders, or database utilities MUST be written in JavaScript/TypeScript and executed with: ${runtimeCmd} run script.ts
  Do NOT use Python or other runtimes.`;

    rule7Text = `RULE 7 — TS/JS DEPENDENCIES:
  Resolve dependencies using ${isDeno ? 'deno cache' : 'bun add X'} as appropriate.`;

    rule9Text = `RULE 9 — ${runtimeName.toUpperCase()} DATABASE SCHEMAS AND SEEDING:
  - Inspect database schemas in the TS/JS model files in the workspace.
  - To seed the database, write a TS/JS script (e.g. <patch file="seed.ts">) and run it using: <exec command="${runtimeCmd} run --allow-all seed.ts" />.
  - Connection options: Always use database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — READ RUNTIME ERROR TRACES:
  Read the standard JS/TS stack trace, locate the exact file and line, apply patches, and re-run.`;

    abilitiesExamples = `   - Read files: <exec command="cat deps.ts" /> or package.json
   - Find files: <exec command="find . -name '*.ts'" />
   - Run script: <exec command="${runtimeCmd} run --allow-all seed.ts" />
3. TOKEN EFFICIENCY: Write standalone scripts via <patch> and execute them.`;
  } else if (isElixir) {
    rule2Text = `RULE 2 — USE ELIXIR RUNTIME:
  Elixir and Mix are available in this container.
  All scripts, seeders, or database utilities MUST be written in Elixir and run with mix tasks or elixir scripts.
  Do NOT use Python or JavaScript for database seeding in an Elixir project.`;

    rule7Text = `RULE 7 — ELIXIR DEPENDENCIES:
  Run: <exec command="mix deps.get" /> to fetch missing dependencies.`;

    rule9Text = `RULE 9 — ELIXIR DATABASE SCHEMAS AND SEEDING:
  This project is an Elixir/Phoenix project.
  - Inspect Ecto schema files in lib/ to understand database layout.
  - To seed the database, run: <exec command="mix run priv/repo/seeds.exs" /> or write custom Elixir tasks.
  - Connection options: Always use database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE ELIXIR ERRORS:
  Trace Phoenix/Elixir compilation or runtime exceptions, patch Elixir source files, and run again.`;

    abilitiesExamples = `   - Read files: <exec command="cat config/dev.exs" />
   - Find files: <exec command="find . -name '*.ex'" />
   - Run seeds: <exec command="mix run priv/repo/seeds.exs" />
3. TOKEN EFFICIENCY: Write seeding mix tasks or seed.exs file via <patch> and execute them.`;
  } else if (isRust) {
    rule2Text = `RULE 2 — USE RUST ENVIRONMENT:
  Rust and Cargo are available in this container.
  All scripts, seeders, or database utilities must be run using cargo or raw SQL scripts.
  Do NOT use Python or JavaScript for database seeding in a Rust project.`;

    rule7Text = `RULE 7 — CARGO CRATES DEPENDENCIES:
  Add missing dependency crates to Cargo.toml and rebuild.`;

    rule9Text = `RULE 9 — RUST DATABASE SCHEMAS AND SEEDING:
  This project is a Rust project.
  - Inspect struct definitions and migrations in Cargo workspace to understand schema.
  - To seed the database, execute raw SQL scripts directly inside database container, or write custom cargo binary tasks.
  - Connection options: Always use database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE CARGO COMPILER ERRORS:
  Identify cargo build errors, locate the file and line, apply patches, and compile again.`;

    abilitiesExamples = `   - Read files: <exec command="cat Cargo.toml" />
   - Find files: <exec command="find . -name '*.rs'" />
   - Compile: <exec command="cargo check" />
3. TOKEN EFFICIENCY: Create SQL script or rust binary task via <patch> and execute it.`;
  } else {
    rule2Text = `RULE 2 — SCRIPT RUNTIME:
  Use Node.js (node) or Python (python3) as the helper script runtime inside the container, whichever is installed and appropriate for the tech stack.
  All scripts and utilities (such as database seeders) MUST be executed using the appropriate runtime for the files.`;

    rule7Text = `RULE 7 — LANGUAGE SPECIFIC DEPENDENCIES:
  Install dependencies using the appropriate package manager for the project (npm for Node, pip3 for Python, composer for PHP, cargo for Rust, mvn/gradle for Java, etc.) inside the container.`;

    rule9Text = `RULE 9 — DATABASE MODELS AND SEEDING:
  - First locate and inspect the schema/model definitions in the workspace using read-only commands.
  - To seed the database or run helper scripts, write seed scripts in the main language of the project (or standard JS/Python helper scripts if supported) and run them.
  - Always use the proper environment variables or database container hostnames as defined in Rule 3 (never use localhost).`;

    rule11Text = `RULE 11 — ANALYZE EXECUTION ERRORS:
  If a script/command execution fails, read the terminal stderr output carefully to find the exact line and file that crashed. Inspect and patch files accordingly.`;

    abilitiesExamples = `   - Read files: <exec command="cat config.json" />
   - Find files: <exec command="find . -type f -not -path '*/node_modules/*'" />
   - Install packages: <exec command="npm install" /> or package manager commands
   - Run scripts: <exec command="node seed.js" /> or stack execution commands
3. TOKEN EFFICIENCY: For database seeding, create a standalone script via <patch> and run it.`;
  }

  return {
    rule2Text,
    rule7Text,
    rule9Text,
    rule11Text,
    abilitiesExamples
  };
};

module.exports = {
  getStackRules
};
