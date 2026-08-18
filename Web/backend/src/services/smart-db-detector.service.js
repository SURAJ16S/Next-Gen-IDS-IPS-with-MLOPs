const fs = require('fs');
const path = require('path');

/**
 * Static analysis scanner to detect database types, table/collection structures,
 * and identify candidate user login/registration tables to generate optimal seed scripts.
 */

// Files/folders to ignore during scanning
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'target', 'vendor', '.venv',
  '.security-reports', 'bin', 'obj', 'gradle', '.idea', '.vscode'
]);

const IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.mp4', '.mp3', '.woff', '.woff2', '.ttf', '.eot', '.exe', '.dll', '.bin'
]);

/**
 * Recursively scans directory and invokes callback on eligible files.
 */
const walkDir = (dir, callback) => {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walkDir(fullPath, callback);
      }
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!IGNORE_EXTS.has(ext)) {
        callback(fullPath, entry.name);
      }
    }
  }
};

/**
 * Main database detection function.
 * @param {string} targetDir - Absolute path to extracted build directory
 */
const scanDirectoryForDatabase = (targetDir) => {
  const result = {
    detectedDbTypes: new Set(),
    detectedHashTypes: new Set(),
    tables: [], // [{ tableName, columns: [], isUserTable: false, rawDefinition: '' }]
    userTableCandidate: null, // { tableName, columns: [] }
    sqliteFiles: [],
    packageDbDeps: []
  };

  const sqlCreateRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"'\w]+\.)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)/gi;
  const sequelizeDefineRegex = /sequelize\.define\(\s*['"`](\w+)['"`]\s*,\s*\{([\s\S]*?)\}/gi;
  const mongooseModelRegex = /mongoose\.model\(\s*['"`](\w+)['"`]\s*,\s*(?:new\s+Schema|schema)/gi;
  const mongooseSchemaRegex = /(?:const|let|var)\s+(\w+Schema)\s*=\s*new\s+(?:mongoose\.)?Schema\(\s*\{([\s\S]*?)\}/gi;
  const prismaModelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\}/gi;
  const djangoModelRegex = /class\s+(\w+)\s*\(\s*(?:models\.Model|User)\s*\)\s*:\s*([\s\S]*?)(?=\n\s*(?:class|def|#|$))/gi;
  const railsMigrationRegex = /create_table\s+:(\w+)(?:[\s\S]*?)(?:do\s+\|t\|([\s\S]*?)end)/gi;
  const jpaEntityRegex = /@Entity[\s\S]*?(?:@Table\(\s*name\s*=\s*["'](\w+)["']\s*\))?[\s\S]*?class\s+(\w+)/gi;
  const dynamicDbCollectionRegex = /db\.(\w+)\.(?:find|insert|update|delete|create|drop|aggregate)/gi;

  walkDir(targetDir, (filePath, fileName) => {
    // 1. Detect local SQLite database files
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.sqlite' || ext === '.sqlite3' || ext === '.db') {
      const relPath = path.relative(targetDir, filePath).replace(/\\/g, '/');
      result.sqliteFiles.push(relPath);
      result.detectedDbTypes.add('sqlite');
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');

      // 2. Scan file content for DB dependencies & connections
      const lowercaseContent = content.toLowerCase();

      // Detect password hashing libraries & functions
      if (lowercaseContent.includes('bcrypt') || lowercaseContent.includes('bcryptjs')) {
        result.detectedHashTypes.add('bcrypt');
      }
      if (lowercaseContent.includes('sha256') || lowercaseContent.includes("createhash('sha256')") || lowercaseContent.includes("createhash(\"sha256\")") || lowercaseContent.includes('hashlib.sha256') || lowercaseContent.includes('sha-256')) {
        result.detectedHashTypes.add('sha256');
      }
      if (lowercaseContent.includes('sha512') || lowercaseContent.includes("createhash('sha512')") || lowercaseContent.includes("createhash(\"sha512\")") || lowercaseContent.includes('hashlib.sha512') || lowercaseContent.includes('sha-512')) {
        result.detectedHashTypes.add('sha512');
      }
      if (lowercaseContent.includes('md5') || lowercaseContent.includes("createhash('md5')") || lowercaseContent.includes("createhash(\"md5\")") || lowercaseContent.includes('hashlib.md5')) {
        result.detectedHashTypes.add('md5');
      }
      if (lowercaseContent.includes('sha1') || lowercaseContent.includes("createhash('sha1')") || lowercaseContent.includes("createhash(\"sha1\")") || lowercaseContent.includes('hashlib.sha1')) {
        result.detectedHashTypes.add('sha1');
      }
      if (lowercaseContent.includes('pbkdf2')) {
        result.detectedHashTypes.add('pbkdf2');
      }
      if (lowercaseContent.includes('argon2')) {
        result.detectedHashTypes.add('argon2');
      }
      if (lowercaseContent.includes('mysql://') || lowercaseContent.includes('mysql-connector') || lowercaseContent.includes('mysql2')) {
        result.detectedDbTypes.add('mysql');
      }
      if (lowercaseContent.includes('postgres://') || lowercaseContent.includes('postgresql://') || lowercaseContent.includes('pg-promise') || lowercaseContent.includes('pg.')) {
        result.detectedDbTypes.add('postgres');
      }
      if (lowercaseContent.includes('mongodb://') || lowercaseContent.includes('mongodb+srv://') || lowercaseContent.includes('mongoose') || lowercaseContent.includes('pymongo')) {
        result.detectedDbTypes.add('mongodb');
      }
      if (lowercaseContent.includes('redis://') || lowercaseContent.includes('redis.createclient')) {
        result.detectedDbTypes.add('redis');
      }
      if (lowercaseContent.includes('sqlite://') || lowercaseContent.includes('sqlite3') || lowercaseContent.includes('db.sqlite')) {
        result.detectedDbTypes.add('sqlite');
      }
      if (lowercaseContent.includes('mariadb://') || lowercaseContent.includes('mariadb-connector')) {
        result.detectedDbTypes.add('mariadb');
      }
      if (lowercaseContent.includes('sqlserver://') || lowercaseContent.includes('mssql') || lowercaseContent.includes('jdbc:sqlserver')) {
        result.detectedDbTypes.add('mssql');
      }
      if (lowercaseContent.includes('cassandra://') || lowercaseContent.includes('cassandra-driver') || lowercaseContent.includes('cqlsh')) {
        result.detectedDbTypes.add('cassandra');
      }
      if (lowercaseContent.includes('oracle://') || lowercaseContent.includes('oracledb') || lowercaseContent.includes('jdbc:oracle')) {
        result.detectedDbTypes.add('oracle');
      }

      // 3. Extract tables/collections using regex
      
      // SQL Table structures (migration scripts, sql dumps)
      let match;
      sqlCreateRegex.lastIndex = 0;
      while ((match = sqlCreateRegex.exec(content)) !== null) {
        const tableName = match[1];
        const body = match[2];
        const columns = parseSqlColumns(body);
        result.tables.push({ tableName, columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Sequelize models
      sequelizeDefineRegex.lastIndex = 0;
      while ((match = sequelizeDefineRegex.exec(content)) !== null) {
        const tableName = match[1];
        const body = match[2];
        const columns = parseJsObjKeys(body);
        result.tables.push({ tableName, columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Mongoose schemas
      mongooseSchemaRegex.lastIndex = 0;
      while ((match = mongooseSchemaRegex.exec(content)) !== null) {
        const schemaName = match[1];
        const body = match[2];
        const columns = parseJsObjKeys(body);
        // Find if schema gets bound to model
        const modelName = findMongooseModelName(content, schemaName) || schemaName.replace(/Schema$/i, '');
        result.tables.push({ tableName: modelName.toLowerCase(), columns, dbEngine: 'mongodb', sourceFile: fileName });
      }

      // Mongoose direct models (no explicit separate schema declaration matched)
      mongooseModelRegex.lastIndex = 0;
      while ((match = mongooseModelRegex.exec(content)) !== null) {
        const modelName = match[1];
        const exists = result.tables.some(t => t.tableName.toLowerCase() === modelName.toLowerCase());
        if (!exists) {
          result.tables.push({ tableName: modelName.toLowerCase(), columns: ['username', 'password', 'email'], dbEngine: 'mongodb', sourceFile: fileName });
        }
      }

      // Prisma schemas
      prismaModelRegex.lastIndex = 0;
      while ((match = prismaModelRegex.exec(content)) !== null) {
        const modelName = match[1];
        const body = match[2];
        const columns = parsePrismaFields(body);
        result.tables.push({ tableName: modelName.toLowerCase(), columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Django models
      djangoModelRegex.lastIndex = 0;
      while ((match = djangoModelRegex.exec(content)) !== null) {
        const modelName = match[1];
        const body = match[2];
        const columns = parseDjangoFields(body);
        result.tables.push({ tableName: modelName.toLowerCase(), columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Ruby on Rails Active Record migrations
      railsMigrationRegex.lastIndex = 0;
      while ((match = railsMigrationRegex.exec(content)) !== null) {
        const tableName = match[1];
        const body = match[2];
        const columns = parseRailsFields(body);
        result.tables.push({ tableName, columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Java JPA class entities
      jpaEntityRegex.lastIndex = 0;
      while ((match = jpaEntityRegex.exec(content)) !== null) {
        const tableName = match[1] || match[2]; // fallback to class name
        const body = content.slice(match.index); // read class content roughly
        const columns = parseJavaFields(body);
        result.tables.push({ tableName, columns, dbEngine: 'sql', sourceFile: fileName });
      }

      // Dynamic MongoDB collection queries (like PyMongo db.users.find())
      dynamicDbCollectionRegex.lastIndex = 0;
      while ((match = dynamicDbCollectionRegex.exec(content)) !== null) {
        const tableName = match[1];
        if (tableName !== 'command') { // Ignore admin db.command
          const exists = result.tables.some(t => t.tableName.toLowerCase() === tableName.toLowerCase());
          if (!exists) {
            result.tables.push({ tableName: tableName.toLowerCase(), columns: ['username', 'password', 'email'], dbEngine: 'mongodb', sourceFile: fileName });
          }
        }
      }

    } catch (e) {
      // Skip file read error gracefully
    }
  });

  // Deduplicate and clean up result tables
  const uniqueTablesMap = new Map();
  for (const t of result.tables) {
    const key = t.tableName.toLowerCase();
    if (!uniqueTablesMap.has(key)) {
      uniqueTablesMap.set(key, t);
    } else {
      // Merge columns if duplicate names found from different file passes
      const existing = uniqueTablesMap.get(key);
      const merged = Array.from(new Set([...existing.columns, ...t.columns]));
      existing.columns = merged;
    }
  }
  result.tables = Array.from(uniqueTablesMap.values());

  // Identify the optimal candidate for the "user login validation table"
  findUserLoginTable(result);

  return {
    detectedDbTypes: Array.from(result.detectedDbTypes),
    tables: result.tables,
    userTableCandidate: result.userTableCandidate,
    detectedHashTypes: Array.from(result.detectedHashTypes)
  };
};

/**
 * Parses raw columns/properties inside SQL DDL parenthesized body.
 */
function parseSqlColumns(body) {
  const columns = [];
  const lines = body.split(',');
  const colRegex = /^\s*[`"']?(\w+)[`"']?\s+([A-Z0-9_()]+)/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PRIMARY KEY') || trimmed.startsWith('FOREIGN KEY') || trimmed.startsWith('KEY') || trimmed.startsWith('CONSTRAINT') || trimmed.startsWith('UNIQUE')) {
      continue;
    }
    const match = colRegex.exec(trimmed);
    if (match) {
      columns.push(match[1]);
    }
  }
  return columns.length > 0 ? columns : ['id', 'username', 'password'];
}

/**
 * Extract keys from JavaScript / JSON object literal.
 */
function parseJsObjKeys(body) {
  const keys = [];
  const keyRegex = /^\s*[`"']?(\w+)[`"']?\s*:/mg;
  let match;
  while ((match = keyRegex.exec(body)) !== null) {
    keys.push(match[1]);
  }
  return keys.length > 0 ? keys : ['username', 'password'];
}

/**
 * Extract field names from Prisma schema definition body.
 */
function parsePrismaFields(body) {
  const fields = [];
  const fieldRegex = /^\s*(\w+)\s+(\w+)/mg;
  let match;
  while ((match = fieldRegex.exec(body)) !== null) {
    const field = match[1];
    if (field !== '@@unique' && field !== '@@index' && field !== '@@id') {
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Extract field names from Django models python body.
 */
function parseDjangoFields(body) {
  const fields = [];
  const fieldRegex = /^\s*(\w+)\s*=\s*models\./mg;
  let match;
  while ((match = fieldRegex.exec(body)) !== null) {
    fields.push(match[1]);
  }
  return fields;
}

/**
 * Extract fields from Ruby on Rails migrations.
 */
function parseRailsFields(body) {
  const fields = [];
  const fieldRegex = /t\.(string|integer|text|datetime|boolean|index)\s+:(\w+)/g;
  let match;
  while ((match = fieldRegex.exec(body)) !== null) {
    fields.push(match[2]);
  }
  return fields;
}

/**
 * Parse Java field names from file segment.
 */
function parseJavaFields(body) {
  const fields = [];
  const fieldRegex = /(?:private|public|protected)\s+[\w<>]+\s+(\w+)\s*;/g;
  // Get content until class end brace
  const firstBraceIdx = body.indexOf('{');
  if (firstBraceIdx === -1) return ['id', 'username', 'password'];
  
  let braceCount = 1;
  let endIdx = firstBraceIdx + 1;
  while (braceCount > 0 && endIdx < body.length) {
    if (body[endIdx] === '{') braceCount++;
    else if (body[endIdx] === '}') braceCount--;
    endIdx++;
  }
  const classContent = body.slice(firstBraceIdx, endIdx);

  let match;
  while ((match = fieldRegex.exec(classContent)) !== null) {
    fields.push(match[1]);
  }
  return fields.length > 0 ? fields : ['id', 'username', 'password'];
}

/**
 * Find mongoose.model calls matching schemaName.
 */
function findMongooseModelName(content, schemaName) {
  const regex = new RegExp(`mongoose\\.model\\(\\s*['"\`](\\w+)['"\`]\\s*,\\s*${schemaName}`, 'i');
  const match = regex.exec(content);
  return match ? match[1] : null;
}

/**
 * Score and find the optimal user login table/collection.
 */
function findUserLoginTable(result) {
  let bestCandidate = null;
  let highestScore = -1;

  for (const t of result.tables) {
    let score = 0;
    const name = t.tableName.toLowerCase();
    
    // Name checks
    if (name === 'users' || name === 'user' || name === 'admin') score += 100;
    else if (name.includes('user') || name.includes('admin') || name.includes('account') || name.includes('credential')) score += 50;
    else if (name.includes('member') || name.includes('profile')) score += 20;

    // Column checks
    const colSet = new Set(t.columns.map(c => c.toLowerCase()));
    if (colSet.has('password') || colSet.has('pwd') || colSet.has('pass') || colSet.has('password_hash')) score += 40;
    if (colSet.has('username') || colSet.has('user_name')) score += 30;
    if (colSet.has('email')) score += 20;

    if (score > highestScore && score >= 40) {
      highestScore = score;
      bestCandidate = t;
    }
  }

  if (bestCandidate) {
    bestCandidate.isUserTable = true;
    result.userTableCandidate = {
      tableName: bestCandidate.tableName,
      columns: bestCandidate.columns
    };
  } else if (result.tables.length > 0) {
    // Fallback: take the table containing password column, else the first table
    const passTable = result.tables.find(t => t.columns.some(c => c.toLowerCase().includes('pass') || c.toLowerCase().includes('pwd')));
    if (passTable) {
      passTable.isUserTable = true;
      result.userTableCandidate = { tableName: passTable.tableName, columns: passTable.columns };
    } else {
      const fallback = result.tables[0];
      fallback.isUserTable = true;
      result.userTableCandidate = { tableName: fallback.tableName, columns: fallback.columns };
    }
  }
}

/**
 * Generate seed initialization scripts for a target DB engine and detected user table.
 * @param {string} dbEngine - mysql, postgres, mongodb, sqlite, mariadb, mssql, oracle, cassandra, redis
 * @param {object} userTableCandidate - { tableName, columns }
 * @param {Array} allDetectedTables - List of all parsed tables
 */
function getPasswordHash(detectedHashTypes) {
  const hashSet = new Set(detectedHashTypes.map(h => h.toLowerCase()));
  if (hashSet.has('bcrypt')) {
    return '$2b$10$n4HEJI.K.r1usTbPijP21.pOlAkFqtnwvKzPyHnMNDh/hXGj49yBi';
  }
  if (hashSet.has('sha256')) {
    return '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';
  }
  if (hashSet.has('sha512')) {
    return '7fcf4ba391c48784edde599889d6e3f1e47a27db36ecc050cc92f259bfac38afad2c68a1ae804d77075e8fb722503f3eca2b2c1006ee6f6c7b7628cb45fffd1d';
  }
  if (hashSet.has('sha1')) {
    return 'f865b53623b121fd34ee5426c792e5c33af8c227';
  }
  if (hashSet.has('md5')) {
    return '0192023a7bbd73250516f069df18b500';
  }
  if (hashSet.has('pbkdf2')) {
    return 'd9a3b63bf0d0bf94cf9833cb91bf7d86f781df5734e5658b4f0b0cf7a3dfc469f6bb17f8a7e08cc895f32eb45a33118991b1f8eb4d5671d1825cb3df29c6934a';
  }
  if (hashSet.has('argon2')) {
    return '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$6c2d1bGQvNnE3aDJrM3YyZzJoM2M0ZDVlNmY3ZzhoOWk';
  }
  return 'admin123';
}

const generateSeedScript = (dbEngine, userTableCandidate, allDetectedTables = [], detectedHashTypes = []) => {
  const engine = (dbEngine || 'mysql').toLowerCase();
  const candidate = userTableCandidate || { tableName: 'users', columns: ['id', 'username', 'password'] };
  
  const colSet = new Set(candidate.columns.map(c => c.toLowerCase()));
  const usernameCol = candidate.columns.find(c => ['username', 'user_name', 'email', 'login'].includes(c.toLowerCase())) || 'username';
  const passwordCol = candidate.columns.find(c => ['password', 'pwd', 'pass', 'password_hash'].includes(c.toLowerCase())) || 'password';

  const defaultUserVal = 'admin';
  const defaultPassVal = getPasswordHash(detectedHashTypes);

  // 1. MongoDB Generation
  if (engine === 'mongodb') {
    let script = '';
    // Build insert for user table
    const insertObj = {};
    for (const col of candidate.columns) {
      if (col === '_id') continue;
      if (col === usernameCol) insertObj[col] = defaultUserVal;
      else if (col === passwordCol) insertObj[col] = defaultPassVal;
      else if (col.toLowerCase() === 'role' || col.toLowerCase() === 'role_id') insertObj[col] = 'admin';
      else if (col.toLowerCase() === 'created_at' || col.toLowerCase() === 'updated_at') script += `// Set timestamp for fields\n`;
      else insertObj[col] = '';
    }
    
    script += `db.${candidate.tableName}.insertOne(${JSON.stringify(insertObj, null, 2)});\n`;

    // Seed other tables if detected (e.g. threats, logs)
    for (const t of allDetectedTables) {
      if (t.tableName === candidate.tableName) continue;
      const lowerTName = t.tableName.toLowerCase();
      if (lowerTName.includes('threat') || lowerTName.includes('alert')) {
        script += `\ndb.${t.tableName}.insertMany([\n  { id: "ALT-101", type: "SQL Injection", severity: "High" },\n  { id: "ALT-102", type: "Brute Force SSH", severity: "Critical" }\n]);\n`;
      }
    }
    return script;
  }

  // 2. Redis Generation
  if (engine === 'redis') {
    return `HMSET user:${defaultUserVal} ${usernameCol} "${defaultUserVal}" ${passwordCol} "${defaultPassVal}" role "admin"\nSADD users "${defaultUserVal}"\n`;
  }

  // 2.5. Vector Database Generation (Qdrant & Chroma)
  if (engine === 'qdrant') {
    return `# Create a Qdrant collection named "${candidate.tableName || 'threat_signatures'}"\n` +
           `curl -X PUT "http://localhost:6333/collections/${candidate.tableName || 'threat_signatures'}" \\\n` +
           `  -H "Content-Type: application/json" \\\n` +
           `  -d '{"vectors": {"size": 4, "distance": "Cosine"}}'\n\n` +
           `# Add a test vector point to the collection\n` +
           `curl -X PUT "http://localhost:6333/collections/${candidate.tableName || 'threat_signatures'}/points?wait=true" \\\n` +
           `  -H "Content-Type: application/json" \\\n` +
           `  -d '{"points": [{"id": 1, "vector": [0.15, 0.22, 0.08, 0.95], "payload": {"rule": "SQL Injection Detect"}}]}';\n`;
  }

  if (engine === 'chroma') {
    return `# Create a Chroma collection named "${candidate.tableName || 'alerts_vectors'}"\n` +
           `curl -X POST "http://localhost:8000/api/v1/collections" \\\n` +
           `  -H "Content-Type: application/json" \\\n` +
           `  -d '{"name": "${candidate.tableName || 'alerts_vectors'}", "metadata": {"description": "IDPS Threat Alerts"}}';\n`;
  }

  // 3. Cassandra CQL Generation
  if (engine === 'cassandra') {
    const colList = [usernameCol, passwordCol];
    const valList = [`'${defaultUserVal}'`, `'${defaultPassVal}'`];
    
    for (const col of candidate.columns) {
      if (col !== usernameCol && col !== passwordCol && col.toLowerCase() !== 'id') {
        colList.push(col);
        valList.push(`'admin'`);
      }
    }

    return `CREATE KEYSPACE IF NOT EXISTS preview_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\n` +
           `USE preview_keyspace;\n` +
           `CREATE TABLE IF NOT EXISTS ${candidate.tableName} (\n` +
           `  ${usernameCol} text PRIMARY KEY,\n` +
           `  ${passwordCol} text\n` +
           `);\n` +
           `INSERT INTO ${candidate.tableName} (${colList.join(', ')}) VALUES (${valList.join(', ')});\n`;
  }

  // 4. SQL Databases (MySQL, PostgreSQL, MariaDB, SQLite, MSSQL, Oracle)
  const columnsList = [];
  const valuesList = [];
  
  // Assemble table creation if SQLite or standard databases need mock structure mapping
  let tableCreationPart = '';
  if (engine === 'sqlite' || allDetectedTables.length === 0) {
    const colDefs = [];
    for (const col of candidate.columns) {
      const lower = col.toLowerCase();
      if (lower === 'id' || lower === 'serial_id') {
        if (engine === 'sqlite') colDefs.push(`  ${col} INTEGER PRIMARY KEY AUTOINCREMENT`);
        else if (engine === 'postgres') colDefs.push(`  ${col} SERIAL PRIMARY KEY`);
        else if (engine === 'mssql') colDefs.push(`  ${col} INT IDENTITY(1,1) PRIMARY KEY`);
        else colDefs.push(`  ${col} INT AUTO_INCREMENT PRIMARY KEY`);
      } else {
        colDefs.push(`  ${col} VARCHAR(255)`);
      }
    }
    tableCreationPart = `CREATE TABLE IF NOT EXISTS ${candidate.tableName} (\n${colDefs.join(',\n')}\n);\n\n`;
  }

  for (const col of candidate.columns) {
    const lower = col.toLowerCase();
    if (lower === 'id' || lower === 'serial_id' || lower === 'created_at' || lower === 'updated_at') {
      continue;
    }
    columnsList.push(col);
    if (col === usernameCol) valuesList.push(`'${defaultUserVal}'`);
    else if (col === passwordCol) valuesList.push(`'${defaultPassVal}'`);
    else if (lower.includes('role')) valuesList.push(`'admin'`);
    else valuesList.push(`'admin_user'`);
  }

  if (columnsList.length === 0) {
    columnsList.push(usernameCol, passwordCol);
    valuesList.push(`'${defaultUserVal}'`, `'${defaultPassVal}'`);
  }

  let script = tableCreationPart;
  if (engine === 'sqlite') {
    script += `INSERT OR IGNORE INTO ${candidate.tableName} (${columnsList.join(', ')}) VALUES (${valuesList.join(', ')});`;
  } else if (engine === 'mssql') {
    script += `IF NOT EXISTS (SELECT * FROM ${candidate.tableName} WHERE ${usernameCol} = '${defaultUserVal}')\n` +
              `BEGIN\n` +
              `  INSERT INTO ${candidate.tableName} (${columnsList.join(', ')}) VALUES (${valuesList.join(', ')});\n` +
              `END;`;
  } else if (engine === 'oracle') {
    script = `DECLARE\n` +
             `  c INT;\n` +
             `BEGIN\n` +
             `  SELECT COUNT(*) INTO c FROM user_tables WHERE table_name = '${candidate.tableName.toUpperCase()}';\n` +
             `  IF c = 0 THEN\n` +
             `    EXECUTE IMMEDIATE 'CREATE TABLE ${candidate.tableName} (${usernameCol} VARCHAR2(255) PRIMARY KEY, ${passwordCol} VARCHAR2(255))';\n` +
             `  END IF;\n` +
             `  EXECUTE IMMEDIATE 'INSERT INTO ${candidate.tableName} (${usernameCol}, ${passwordCol}) VALUES (''${defaultUserVal}'', ''${defaultPassVal}'')';\n` +
             `EXCEPTION WHEN OTHERS THEN NULL;\n` +
             `END;\n/`;
  } else {
    // MySQL, PostgreSQL, MariaDB
    script += `INSERT INTO ${candidate.tableName} (${columnsList.join(', ')}) VALUES (${valuesList.join(', ')}) ` +
              `ON DUPLICATE KEY UPDATE ${passwordCol}=VALUES(${passwordCol});`;
  }

  // Generate auxiliary tables if detected and we are running mysql/postgres/mariadb
  if (allDetectedTables.length > 0 && (engine === 'mysql' || engine === 'postgres' || engine === 'mariadb')) {
    for (const t of allDetectedTables) {
      if (t.tableName === candidate.tableName) continue;
      const lower = t.tableName.toLowerCase();
      if (lower.includes('threat') || lower.includes('alert')) {
        script += `\n\n-- Seeding threat metadata if available\n` +
                  `CREATE TABLE IF NOT EXISTS ${t.tableName} (\n` +
                  `  id VARCHAR(50) PRIMARY KEY,\n` +
                  `  type VARCHAR(255),\n` +
                  `  severity VARCHAR(50)\n` +
                  `);\n` +
                  `INSERT INTO ${t.tableName} (id, type, severity) VALUES\n` +
                  `  ('ALT-101', 'SQL Injection', 'High'),\n` +
                  `  ('ALT-102', 'Brute Force SSH', 'Critical')\n` +
                  `  ON DUPLICATE KEY UPDATE severity=VALUES(severity);`;
      }
    }
  }

  return script;
};

module.exports = {
  scanDirectoryForDatabase,
  generateSeedScript
};
