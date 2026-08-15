const fs = require('fs');
const path = require('path');

const SECRETS_REGEXES = {
  'AWS Access Key': /AKIA[0-9A-Z]{16}/g,
  'AWS Secret Key': /(?:aws|secret|key|access|access_key|secret_key)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'Cloudflare R2 Access Key ID': /r2_(?:access_key_id|access_key|key_id)\s*[:=]\s*["']?[A-Za-z0-9]{20,40}["']?/gi,
  'Cloudflare R2 Secret Key': /r2_(?:secret_access_key|secret_key|secret)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'S3 Access Key ID': /s3_(?:access_key_id|access_key|key_id)\s*[:=]\s*["']?[A-Za-z0-9]{20,40}["']?/gi,
  'S3 Secret Key': /s3_(?:secret_access_key|secret_key|secret)\s*[:=]\s*["']?[A-Za-z0-9/\+=]{40}["']?/gi,
  'MongoDB URI': /mongodb(?:\+srv)?:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+/gi,
  'PostgreSQL URI': /postgres(?:ql)?:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+/gi,
  'MySQL URI': /mysql:\/\/[a-zA-Z0-9_.-]+:[^@\s]+@[a-zA-Z0-9.-]+/gi,
  'Redis URI': /redis:\/\/(?:[^:]+:[^@]+@)?[a-zA-Z0-9.-]+:[0-9]+/gi,
  'Private Key': /-----BEGIN [A-Z ]+ PRIVATE KEY-----/g,
  'Slack Token': /xox[bapr]-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}/g,
  'Slack Webhook': /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9_]+\/B[A-Z0-9_]+\/[A-Za-z0-9_]+/g,
  'Discord Webhook': /https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[a-zA-Z0-9\-_]+/g,
  'Stripe API Key': /sk_live_[0-9a-zA-Z]{24}/g,
  'Google API Key': /AIza[0-9A-Za-z\-_]{35}/g,
  'GitHub Token': /ghp_[a-zA-Z0-9]{36}/g,
  'Generic Secret/Token': /(?:jwt_secret|api_key|apikey|auth_token|client_secret|client_key|client_password|db_password)\s*[:=]\s*["'](?![$.])([A-Za-z0-9_\-\.\+=!@#$%^&*()]{8,128})["']/gi
};

const walkDir = (dir, callback) => {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const baseName = path.basename(filePath);
      if (['node_modules', '.git', '.venv', 'venv', 'build', 'dist', 'target', '.security-reports'].includes(baseName)) {
        continue;
      }
      walkDir(filePath, callback);
    } else {
      callback(filePath);
    }
  }
};

const scanDirectory = (dir) => {
  const findings = [];
  walkDir(dir, (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath);
    
    // Skip .env files (credentials belong there)
    if (baseName.startsWith('.env')) {
      return;
    }
    
    // Only scan text files
    const textExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.properties', '.xml', '.yml', '.yaml', '.json', '.rs', '.go', '.html', '.css', '.txt'];
    if (!textExtensions.includes(ext)) {
      return;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const [type, regex] of Object.entries(SECRETS_REGEXES)) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(line)) !== null) {
            const matchStr = match[0];
            // Filter out common environment variable references
            if (
              matchStr.includes('process.env') || 
              matchStr.includes('os.environ') || 
              matchStr.includes('System.getenv') || 
              matchStr.includes('config.') ||
              matchStr.includes('${')
            ) {
              continue;
            }
            
            // Mask the found secret
            const matchedVal = match[1] || matchStr;
            let maskedSecret = matchStr;
            if (matchedVal.length > 5) {
              const mask = matchedVal.substring(0, Math.min(3, matchedVal.length)) + '...[MASKED]';
              maskedSecret = matchStr.replace(matchedVal, mask);
            } else {
              maskedSecret = '[MASKED_SECRET]';
            }
            
            findings.push({
              file: path.relative(dir, filePath).replace(/\\/g, '/'),
              line: i + 1,
              type,
              match: maskedSecret,
              rawMatch: matchStr,
              rawSecret: matchedVal
            });
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning file for credentials: ${filePath}`, err);
    }
  });
  return findings;
};

const getReplacementString = (ext, varName) => {
  if (ext === '.py') {
    return `os.environ.get('${varName}')`;
  } else if (ext === '.java') {
    return `System.getenv("${varName}")`;
  } else if (ext === '.rs') {
    return `std::env::var("${varName}").unwrap_or_default()`;
  } else if (ext === '.properties' || ext === '.yml' || ext === '.yaml') {
    return `\${${varName}}`;
  } else {
    return `process.env.${varName}`;
  }
};

const autoRemediate = (dir, findings) => {
  const envToInject = {};
  const fileMap = {};
  findings.forEach(f => {
    const fullPath = path.join(dir, f.file);
    if (!fileMap[fullPath]) fileMap[fullPath] = [];
    fileMap[fullPath].push(f);
  });

  let counter = 1;

  for (const [filePath, fileFindings] of Object.entries(fileMap)) {
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const ext = path.extname(filePath).toLowerCase();

    for (const finding of fileFindings) {
      const lineIdx = finding.line - 1;
      if (lineIdx < 0 || lineIdx >= lines.length) continue;
      
      let line = lines[lineIdx];
      const varName = `AUTO_SECRET_${counter++}`;
      envToInject[varName] = finding.rawSecret;
      const replacement = getReplacementString(ext, varName);

      const doubleQuoted = `"${finding.rawMatch}"`;
      const singleQuoted = `'${finding.rawMatch}'`;
      const backticked = `\`${finding.rawMatch}\``;

      if (line.includes(doubleQuoted)) {
        line = line.replace(doubleQuoted, replacement);
      } else if (line.includes(singleQuoted)) {
        line = line.replace(singleQuoted, replacement);
      } else if (line.includes(backticked)) {
        line = line.replace(backticked, replacement);
      } else {
        line = line.replace(finding.rawMatch, replacement);
      }
      lines[lineIdx] = line;
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  }

  const envPath = path.join(dir, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
  }
  
  for (const [key, value] of Object.entries(envToInject)) {
    envContent += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  return envToInject;
};

// Main Execution
const targetDir = process.argv[2] || '/tmp/devops-build';
console.log(`[*] Commencing Hardcoded Credentials Scan on: ${targetDir}`);
const findings = scanDirectory(targetDir);

if (findings.length > 0) {
  console.log(`[-] WARNING: Found ${findings.length} hardcoded credential(s) in source files.`);
  console.log(`[*] Auto-remediation active. Replaced credentials in files and saved to .env...`);
  
  const injectedEnv = autoRemediate(targetDir, findings);
  
  for (const f of findings) {
    console.log(`  [+] Replaced [${f.type}] in ${f.file}:${f.line}`);
  }
  
  console.log(`[+] Auto-remediation complete. Added ${Object.keys(injectedEnv).length} variable(s) to .env.`);
  process.exit(0);
} else {
  console.log('[+] No hardcoded credentials detected outside of .env files.');
  process.exit(0);
}
