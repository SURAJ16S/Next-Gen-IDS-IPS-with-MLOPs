const fs = require('fs');
const path = require('path');

/**
 * Diagnostic Engine to analyze logs/errors and suggest fixes.
 * @param {string} logsText - Combined stdout/stderr output.
 * @returns {Array} List of diagnosed errors and recommended fixes.
 */
const analyzeLogsAndDiagnose = (logsText) => {
  const diagnoses = [];
  if (!logsText) return diagnoses;

  // 1. Database Connection issues
  if (/MongoServerError:\s*cannot create a new collection|already using 500 collections/i.test(logsText)) {
    diagnoses.push({
      error: "MongoDB Atlas collection limit reached",
      solution: "Your cloud database has reached its maximum free collection limit (500). Please configure MONGODB_URI in your environment variables to point to a local database, or upgrade your database cluster."
    });
  } else if (/MongoServerError|MongooseError|ECONNREFUSED\s+(?:localhost|127\.0\.0\.1|host\.docker\.internal):27017/i.test(logsText)) {
    diagnoses.push({
      error: "MongoDB Connection Failure",
      solution: "Your app failed to connect to MongoDB. Ensure your MongoDB server is running on the host machine, listening on all interfaces (0.0.0.0), and that MONGODB_URI is correctly configured in your environment files."
    });
  } else if (/ECONNREFUSED\s+\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/i.test(logsText)) {
    diagnoses.push({
      error: "Database Connection Refused",
      solution: "A connection to your database or external service was refused. Double-check your host IP address and ensure the external service is running and allows connections from your runner/container."
    });
  }

  // 2. Routing Syntax Errors (Express 5/path-to-regexp v8)
  if (/Missing parameter name|pathToRegexpError|Unexpected\s+.*at index/i.test(logsText)) {
    diagnoses.push({
      error: "Express 5 Routing Compatibility Error",
      solution: "You are running Express v5, which uses path-to-regexp v8. Unnamed wildcards (like `*`) are no longer supported. Please rewrite routes (e.g. change `/your-path/*` to `/your-path/*wildcard`)."
    });
  }

  // 3. Port Conflict (EADDRINUSE)
  if (/EADDRINUSE\s+address already in use/i.test(logsText)) {
    diagnoses.push({
      error: "Port Conflict (Address Already In Use)",
      solution: "The application is hardcoded to listen on a port that is already occupied. Ensure your server code listens on `process.env.PORT` instead of a hardcoded number (like 3000 or 5000)."
    });
  }

  // 4. Missing NPM scripts or builds
  if (/npm ERR! missing script:\s*build/i.test(logsText)) {
    diagnoses.push({
      error: "Missing Build Script",
      solution: "Your package.json defines a build command that does not exist. Add a `\"build\"` script or remove the build trigger if your app does not require compiling."
    });
  }

  // 5. Module not found / missing dependency
  const moduleMissingMatch = logsText.match(/Error: Cannot find module ['"]([^'"]+)['"]/);
  if (moduleMissingMatch) {
    const missingModule = moduleMissingMatch[1];
    diagnoses.push({
      error: `Missing Node Module (${missingModule})`,
      solution: `The dependency "${missingModule}" was required but not found. Make sure it is listed in your package.json dependencies and that npm install completed successfully.`
    });
  }

  // 6. TS5108 moduleResolution node10 error
  if (/TS5108:\s*Option\s+['"]moduleResolution=node10['"]\s+has\s+been\s+removed/i.test(logsText)) {
    diagnoses.push({
      error: "Deprecated ModuleResolution option in tsconfig.json",
      solution: "The option 'moduleResolution=node10' (or 'node') has been deprecated or removed in newer TypeScript compiler versions. Remove this property from your tsconfig.json file or upgrade it to 'node16' or 'nodenext'."
    });
  }

  // 7. Generic TypeScript compile errors (e.g., TS2769, TS7016, etc.)
  if (/error TS\d{4}:/i.test(logsText)) {
    const tsErrors = [...logsText.matchAll(/error (TS\d{4}):\s*([^\r\n]+)/gi)];
    if (tsErrors.length > 0) {
      const uniqueCodes = [...new Set(tsErrors.map(m => m[1]))];
      const solutionsMap = {
        'TS2769': "No overload matches this call. This usually happens when passing query filters or model parameters that don't match your Mongoose database schema or function types. Check your schemas or cast the query parameter object as `any`.",
        'TS7016': "Could not find a declaration file for module. This happens when a package (like 'date-fns') has type resolution conflicts under your current moduleResolution configurations. Try setting `\"noImplicitAny\": false` or `\"skipLibCheck\": true` in your tsconfig.json, or install the `@types/<package>` definition.",
        'TS2307': "Cannot find module or its corresponding type declarations. Make sure the package is listed in your package.json dependencies and npm install completed successfully.",
        'TS5108': "Option 'moduleResolution=node10' has been removed. Delete this setting from your tsconfig.json or upgrade it to 'node16' or 'nodenext'."
      };
      
      uniqueCodes.forEach(code => {
        diagnoses.push({
          error: `TypeScript Compiler Error (${code})`,
          solution: solutionsMap[code] || `TypeScript compiler encountered type verification errors during build. Code: ${code}. You can fix the types locally, or add \`"noEmitOnError": false\` and \`"strict": false\` to your tsconfig.json to allow compilation with warnings.`
        });
      });
    }
  }

  return diagnoses;
};

/**
 * Pre-build validation checks to run static analysis on codebase before build phase.
 * @param {string} targetDir - Directory of the resolved subfolder/root.
 * @param {Function} logCallback - Function to log warnings/info back to deploy pipeline logs.
 * @returns {boolean} Whether configuration warnings were found.
 */
const performPreBuildValidation = (targetDir, logCallback) => {
  logCallback('[VALIDATION] Running pre-build static analysis checks...');
  let hasWarnings = false;

  // 1. Check start script for Node.js apps
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.scripts || !pkg.scripts.start) {
        logCallback('[VALIDATION] [WARNING] Your package.json is missing a "start" script. Previews may fail to launch. We recommend adding a `"start": "node <your-entrypoint>.js"` script.');
        hasWarnings = true;
      }
    } catch (_) {}
  }

  // 2. Scan files for hardcoded local connections and listen ports
  const exts = ['.js', '.ts', '.py', '.rb', '.php', '.java', '.go', '.cs', '.env.example'];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.security-reports']);
  
  const localDbRegex = /(mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/)(?:localhost|127\.0\.0\.1)/i;
  const hardcodedListenRegex = /listen\(\s*(\d{4,5})\s*\)/i;

  let localDbCount = 0;
  let hardcodedPortCount = 0;

  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (exts.some(e => entry.name.endsWith(e))) {
          try {
            const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
            if (localDbRegex.test(content)) localDbCount++;
            if (hardcodedListenRegex.test(content)) hardcodedPortCount++;
          } catch (_) {}
        }
      }
    };
    walk(targetDir);

    if (localDbCount > 0) {
      logCallback(`[VALIDATION] [WARNING] Found ${localDbCount} files referencing localhost database connection strings. Please make sure to configure environment variables for deployment instead of hardcoded strings.`);
      hasWarnings = true;
    }
    if (hardcodedPortCount > 0) {
      logCallback(`[VALIDATION] [WARNING] Found ${hardcodedPortCount} files with hardcoded server port bindings (e.g., app.listen(3000)). For web deployment, ensure your application listens on \`process.env.PORT\` instead.`);
      hasWarnings = true;
    }

    // 3. Scan & Self-heal deprecated tsconfig.json properties (e.g., moduleResolution node/node10)
    try {
      const walkTsConfig = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!ignoreDirs.has(entry.name)) walkTsConfig(path.join(dir, entry.name));
          } else if (entry.name === 'tsconfig.json') {
            const tsConfigPath = path.join(dir, entry.name);
            try {
              const content = fs.readFileSync(tsConfigPath, 'utf8');
              const moduleResolutionRegex = /"moduleResolution"\s*:\s*"(node|node10)"\s*,?/gi;
              if (moduleResolutionRegex.test(content)) {
                logCallback(`[VALIDATION] [FIXED] Found deprecated "moduleResolution": "node/node10" in ${path.relative(targetDir, tsConfigPath)}. Automatically patched file to prevent compile failures.`);
                const updatedContent = content.replace(moduleResolutionRegex, '');
                fs.writeFileSync(tsConfigPath, updatedContent, 'utf8');
              }
            } catch (_) {}
          }
        }
      };
      walkTsConfig(targetDir);
    } catch (_) {}
  } catch (_) {}

  if (!hasWarnings) {
    logCallback('[VALIDATION] [SUCCESS] Pre-build validation complete. No configuration warnings found!');
  } else {
    logCallback('[VALIDATION] Pre-build validation complete with warnings. Review them to ensure a successful deploy.');
  }

  return hasWarnings;
};

module.exports = {
  analyzeLogsAndDiagnose,
  performPreBuildValidation
};
