const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Docker = require('dockerode');
const { 
  setWorkingMemory, 
  getWorkingMemory, 
  deleteWorkingMemory,
  pushObservation, 
  popObservations, 
  saveEpisodicMemory, 
  getRelevantHistory 
} = require('./agent-memory.service');
const { scanContentForCredentials } = require('./credential-scanner.service');

// Utility to clean docker stream output
const cleanDockerOutput = (rawBuffer) => {
  if (!Buffer.isBuffer(rawBuffer)) {
    rawBuffer = Buffer.from(rawBuffer);
  }
  let offset = 0;
  let cleanText = '';
  
  while (offset < rawBuffer.length) {
    if (offset + 8 <= rawBuffer.length) {
      const type = rawBuffer[offset];
      if (type === 1 || type === 2) {
        const size = rawBuffer.readUInt32BE(offset + 4);
        if (size > 0 && offset + 8 + size <= rawBuffer.length) {
          cleanText += rawBuffer.toString('utf8', offset + 8, offset + 8 + size);
          offset += 8 + size;
          continue;
        }
      }
    }
    cleanText += rawBuffer.toString('utf8', offset, offset + 1);
    offset += 1;
  }
  return cleanText;
};

// Flatten workspace files
const getFlatWorkspaceFiles = (dirPath, relativeDir = '') => {
  let list = [];
  if (!fs.existsSync(dirPath)) return list;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (['node_modules', '.git', 'dist', 'build', '.security-reports'].includes(file)) continue;
      const fullPath = path.join(dirPath, file);
      const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
      if (fs.statSync(fullPath).isDirectory()) {
        list = list.concat(getFlatWorkspaceFiles(fullPath, relPath));
      } else {
        list.push(relPath);
      }
    }
  } catch (_) {}
  return list;
};

// Security check for commands
const isCommandSafe = (command) => {
  if (!command || typeof command !== 'string') return false;
  const cmd = command.toLowerCase().trim();
  if (/\brm\s+-[a-z]*r[a-z]*\s+(\/($|\s|\*)|(\.\.)($|\s)|\*)/.test(cmd)) return false;
  if (/\b(nc|netcat|ncat)\b/.test(cmd)) return false;
  if (cmd.includes('/dev/tcp') || cmd.includes('/dev/udp')) return false;
  if (cmd.includes('bash -i') || cmd.includes('sh -i')) return false;
  if (cmd.includes('docker ') || cmd.includes('docker.sock')) return false;
  if (/\b(mkfs|dd|fdisk|parted)\b/.test(cmd) && (cmd.includes('/dev/') || cmd.includes('of='))) return false;
  if (cmd.includes('/etc/passwd') || cmd.includes('/etc/shadow') || cmd.includes('/etc/gshadow') || cmd.includes('/etc/group')) return false;
  if (cmd.includes(':(){') || cmd.includes(':|:&')) return false;
  return true;
};

// Read-only checker
const isReadOnlyCommand = (command) => {
  if (!command || typeof command !== 'string') return false;
  const cmd = command.toLowerCase().trim();
  if (/[><]/.test(cmd)) return false;
  const subParts = cmd.split(/[;&|]/).map(s => s.trim()).filter(Boolean);
  if (subParts.length === 0) return false;
  
  const readKeywords = ['cat', 'ls', 'find', 'grep', 'pwd', 'head', 'tail', 'echo', 'printenv', 'file', 'stat', 'which', 'type', 'du', 'df'];
  for (const part of subParts) {
    const firstWord = part.split(/\s+/)[0];
    if (!readKeywords.includes(firstWord)) {
      return false;
    }
  }
  return true;
};

/**
 * Execute a command inside the DevOps preview container
 */
const runCommandInContainer = async (containerName, cmd) => {
  try {
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(containerName);
    
    let isRunning = false;
    try {
      const inspect = await container.inspect();
      isRunning = inspect.State.Running;
    } catch (_) {}

    if (!isRunning) {
      return `Execution blocked: Preview container "${containerName}" is offline.\n`;
    }

    const exec = await container.exec({ 
      Cmd: ['sh', '-c', `cd /project 2>/dev/null || cd /workspace 2>/dev/null || true; ${cmd}`], 
      AttachStdout: true, 
      AttachStderr: true 
    });
    
    const stream = await exec.start();
    return await new Promise((resolve) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(cleanDockerOutput(fullBuffer));
      });
      stream.on('error', () => resolve(''));
    });
  } catch (err) {
    return `Error executing command: ${err.message}\n`;
  }
};

/**
 * Run the ReAct Agent Loop
 */
const runAgentChatLoop = async (deployment, chatSession, userMessage, resumeLogs = null) => {
  const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
  const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
  const containerName = `devops-preview-${deployment.jobId}`;
  const chatId = chatSession._id.toString();

  // Read package.json to understand workspace dependencies
  let pkgDetails = 'No package.json found';
  try {
    const pkgPath = path.join(extractDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkgDetails = fs.readFileSync(pkgPath, 'utf8');
    } else {
      const serverPkgPath = path.join(extractDir, 'server', 'package.json');
      if (fs.existsSync(serverPkgPath)) {
        pkgDetails = fs.readFileSync(serverPkgPath, 'utf8');
      }
    }
  } catch (_) {}

  const flatFilesList = getFlatWorkspaceFiles(extractDir);
  
  // Construct dynamic system prompt
  const systemPrompt = `You are a DevOps AI Developer Assistant inside a container workspace environment.
You help developers write code, design databases, and perform operational tasks like database seeding, record insertion, or workspace script execution.

Current context:
- Project Tech Stack: ${deployment.techStackDetected || 'MERN'}
- Database type: ${deployment.dbInitType || 'mongodb'}
- Project Package Details:
${pkgDetails}

Current Workspace Files Structure:
${flatFilesList.map(f => ` - ${f}`).join('\n')}

════════════════════════════════════════
NON-NEGOTIABLE BEHAVIORAL RULES (MUST ALWAYS FOLLOW):
════════════════════════════════════════

RULE 1 — SCHEMA FIRST, SEED SECOND:
  When asked to seed data or insert records, you MUST inspect the actual model/schema files first.
  NEVER guess field names. ALWAYS use <exec command="cat path/to/Model.js" /> to read the real schema.
  Step 1: find model files → Step 2: read them → Step 3: generate matching seed data.

RULE 2 — NEVER USE PYTHON:
  Python, python3, pip, pip3, and all Python packages are NOT available in this container.
  All scripts MUST be written in plain JavaScript and run with: node script.js
  If you generate Python code, you are wrong. Use Node.js ALWAYS.

RULE 3 — NEVER USE localhost FOR DATABASES:
  The database is NOT on localhost inside the container. It is a separate Docker container.
  ALWAYS use container hostnames or environment variables:
  - MongoDB:    process.env.MONGODB_URI  || 'mongodb://devops-db-mongodb-${deployment.jobId}:27017/preview_db'
  - PostgreSQL: process.env.DATABASE_URL || 'postgresql://postgres@devops-db-postgres-${deployment.jobId}:5432/preview_db'
  - MySQL:      process.env.DATABASE_URL || 'mysql://root@devops-db-mysql-${deployment.jobId}:3306/preview_db'
  If you write localhost or 127.0.0.1 for a database, you are wrong.
  - Mongoose Connection Option Guard: NEVER use useNewUrlParser: true/false or useUnifiedTopology: true/false. These options are deprecated and will throw a MongoParseError crash. Always connect simply with: mongoose.connect(URI)

RULE 4 — DO, DON'T EXPLAIN:
  Never tell the user HOW to do something. Instead, DO IT for them using <exec> or <patch> tags.
  If the user asks "show me nodemon.json", do NOT say "you can navigate to...".
  Instead: <exec command="find . -name 'nodemon.json' -not -path '*/node_modules/*'" />

RULE 5 — PATCH PATHS ARE RELATIVE FROM WORKSPACE ROOT:
  <patch file="server/models/Product.js">  ✅ CORRECT
  <patch file="/workspace/server/models/Product.js">  ❌ WRONG
  <patch file="./server/models/Product.js">  ❌ WRONG

RULE 6 — RETRY ON ERROR AUTONOMOUSLY:
  If a command fails, analyze the error and retry with a fix without asking the user.
  - "Cannot find module 'X'" → run: <exec command="npm --prefix server install X" /> (installing inside the server folder where Node.js backend runs) then retry.
  - "python: not found" → rewrite the script in Node.js.
  - "ECONNREFUSED 127.0.0.1" → fix the database URL (never use localhost).
  - SyntaxError or TypeError (e.g. leading word "javascript" inside code files) → immediately use <patch file="relative/path/to/file"> to rewrite and clean up the file, then re-run the execution command.

RULE 7 — ts-node IS NOT AVAILABLE:
  Do NOT run TypeScript files with ts-node. Always write plain JavaScript (.js) seed/utility scripts.

RULE 8 — SCAN AND ANALYZE ONLY:
  If the user asks you to "scan", "find", "analyze", "explain", "review", or "locate" (read-only tasks), you must ONLY use read-only commands (like cat, find, grep) to inspect files and reply. Do NOT use <patch> tags to modify or write files, and do NOT write or run new seed scripts. File modifications are ONLY permitted if the user explicitly asks you to "create", "write", "seed", "insert", "update", "fix", or "add".

RULE 9 — MONOREPO DEPENDENCY PATHS:
  This project is a monorepo. Server-side packages (like mongoose, bcrypt, dotenv, etc.) are installed in the "server" directory.
  - ALWAYS write database seeds/utility scripts inside the "server" directory (e.g. <patch file="server/seed.js">) rather than the root directory.
  - ALWAYS run them from the root directory by specifying the subfolder path: <exec command="node server/seed.js" />.
  - If you run them at the root level, node will throw "Cannot find module 'mongoose'".
  - Database models inside this container workspace are located in the "server/dist/models/" directory (e.g., server/dist/models/User.js, server/dist/models/Product.js). ALWAYS read them from there.
  - ES MODULES TRANSLATION: The backend models (like User, Product, Category, etc.) are transpiled to CommonJS. They export their mongoose model as the default export. Therefore, when requiring these models in your CommonJS seed/utility scripts, you MUST append ".default" (e.g. const User = require('./dist/models/User').default;). If you omit ".default", calling methods on the model will throw a TypeError.
  - MIDDLEWARE BYPASS: If a model's pre-save hooks or middleware crash (for example, with "TypeError: next is not a function" during saves), you can bypass them by using raw MongoDB operations directly on the collection: e.g. await Model.collection.insertMany(data). Note that if you bypass pre-save hooks, you must hash passwords manually using bcrypt (const bcrypt = require('bcryptjs'); const hashed = await bcrypt.hash(password, 12);) before inserting.

RULE 10 — DO NOT CONSTRUCT FILES WITH echo:
  NEVER write code or construct files line-by-line using "echo >> file" inside <exec> tags. This is extremely fragile, causes shell quotation/escaping syntax errors, and corrupts scripts. ALWAYS use the <patch> tag to create or edit files instead.

RULE 11 — READ THE TOP OF ERROR STACK TRACES:
  When a node script execution fails with a SyntaxError, TypeError, or similar crash, look at the VERY FIRST file mentioned at the top of the "at Object.<anonymous>" calls in the stack trace. That is the file that contains the crash, not necessarily the seed script itself. Inspect and patch the actual file where the crash occurred to resolve the problem.

════════════════════════════════════════

YOUR DYNAMIC ABILITIES:
1. File patches: Wrap the full content inside a <patch file="relative/path/to/file">...</patch> tag.
2. Executing scripts/commands: Wrap commands inside <exec command="command" /> tags.
   - Read files: <exec command="cat server/models/Product.js" />
   - Find files: <exec command="find . -name '*.js' -path '*/models/*' -not -path '*/node_modules/*'" />
   - Install packages: <exec command="npm install mongoose" />
   - Run scripts: <exec command="node seed.js" />
3. TOKEN EFFICIENCY: For database seeding, create a standalone seed.js via <patch> and run it with <exec command="node seed.js" />.
4. HIDING REASONING: Wrap all internal thinking in <thought>...</thought> blocks. Only show final answers and executable tags to the user.
5. AUTONOMOUS SEARCH: Never describe how to find a file. Always use <exec> to search and cat files directly.

Explain clearly what changes you have made and summarize any execution stdout/stderr results.`;


  // Setup LLM routing
  let url = '';
  let headers = { 'Content-Type': 'application/json' };
  let model = '';
  let isOllama = false;

  const groqKey = process.env.GROQ_API_KEY;
  const hfKey = process.env.HUGGINGFACE_API_KEY;

  if (groqKey && groqKey.trim() !== '') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    headers['Authorization'] = `Bearer ${groqKey}`;
    model = process.env.GROQ_MODEL || 'qwen-2.5-coder-32b';
  } else if (hfKey && hfKey.trim() !== '') {
    url = 'https://api-inference.huggingface.co/v1/chat/completions';
    headers['Authorization'] = `Bearer ${hfKey}`;
    model = process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct';
  } else {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    url = `${ollamaHost}/v1/chat/completions`;
    model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
    isOllama = true;
  }

  // Get relevant episodic history
  const semanticContext = await getRelevantHistory(chatId, userMessage, 5);
  const formattedSemantic = semanticContext.map(m => ({
    role: m.role === 'agent' ? 'assistant' : 'user',
    content: m.content
  }));

  // Setup/Resume State
  let reactHistory = [];
  let currentIteration = 1;
  const maxIterations = 10;

  if (resumeLogs) {
    // We are resuming from user command approval
    const savedState = await getWorkingMemory(chatId, 'react_loop_state');
    if (savedState) {
      reactHistory = savedState.history;
      currentIteration = savedState.iteration + 1;
      
      // Feed user's allowed command output as observation
      reactHistory.push({
        role: 'user',
        content: `Observation of executed commands:\n${resumeLogs}`
      });
      await deleteWorkingMemory(chatId, 'react_loop_state');
    }
  } else {
    // Brand new message
    reactHistory = [
      { role: 'user', content: userMessage }
    ];
  }

  // --- Early liveness check ---
  // Detect offline container BEFORE starting the ReAct loop so the user
  // gets a clear, actionable message instead of a cryptic mid-execution block.
  let containerIsOnline = false;
  try {
    const checkDocker = new Docker();
    const checkContainer = checkDocker.getContainer(containerName);
    const inspect = await checkContainer.inspect();
    containerIsOnline = inspect.State.Running;
  } catch (_) {
    containerIsOnline = false;
  }

  if (!containerIsOnline) {
    return {
      message: `⚠️ **Preview container is offline.**\n\nThe sandbox container \`${containerName}\` is not running. Commands and file patches cannot be executed.\n\n**To fix this:**\n1. Go to your **Deployment** page and click **Start Preview** (or **Restart**).\n2. Once the container starts (usually 5–10 seconds), come back here and try again.\n\nRead-only analysis and explanations still work without a running container.`,
      pendingExec: false,
      commands: [],
      patches: [],
      chatId
    };
  }

  let finalResponseText = '';
  let pendingCommands = [];
  let patchesApplied = [];
  let executionLogs = '';

  while (currentIteration <= maxIterations) {
    console.log(`[REACT LOOP] Iteration ${currentIteration}/${maxIterations} for session ${chatId}`);

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...formattedSemantic,
        ...reactHistory
      ],
      temperature: 0.1
    };

    if (isOllama) {
      payload.options = { num_ctx: 32768 };
    }

    let assistantText = '';
    try {
      const response = await axios.post(url, payload, { headers, timeout: 90000 });
      assistantText = response.data.choices[0].message.content;
    } catch (llmError) {
      console.error('[REACT LOOP] LLM call error:', llmError.message);
      return {
        message: `I encountered an error connecting to the model: ${llmError.message}`,
        pendingExec: false,
        commands: [],
        patches: [],
        chatId
      };
    }

    // Append model output to history
    reactHistory.push({ role: 'assistant', content: assistantText });
    finalResponseText = assistantText;

    // 1. Process Patches
    const patches = [];
    const blockedPatches = [];
    const patchRegex = /<patch\s+file="([^"]+)">([\s\S]*?)<\/patch>/g;
    let match;
    while ((match = patchRegex.exec(assistantText)) !== null) {
      const relPath = match[1];
      let code = match[2];
      
      // Clean leading/trailing markdown code blocks (e.g. ```javascript ... ```)
      let trimmedCode = code.trim();
      if (trimmedCode.startsWith('```')) {
        const firstNewline = trimmedCode.indexOf('\n');
        if (firstNewline !== -1) {
          trimmedCode = trimmedCode.substring(firstNewline + 1).trim();
        }
      }
      if (trimmedCode.endsWith('```')) {
        trimmedCode = trimmedCode.substring(0, trimmedCode.length - 3).trim();
      }
      
      // Clean leading markdown language name (e.g. "javascript\n", "js\n", "json\n" etc.)
      const firstLineMatch = trimmedCode.match(/^([a-zA-Z0-9_\-#+]+)\s*\n/);
      if (firstLineMatch) {
        const potentialLang = firstLineMatch[1].toLowerCase();
        const supportedLangs = ['javascript', 'js', 'json', 'html', 'css', 'python', 'py', 'bash', 'sh', 'sql', 'yaml', 'yml', 'xml', 'typescript', 'ts'];
        if (supportedLangs.includes(potentialLang)) {
          const firstLineLength = firstLineMatch[0].length;
          trimmedCode = trimmedCode.substring(firstLineLength).trim();
        }
      }
      
      code = trimmedCode;
      
      const targetAbsPath = path.resolve(extractDir, relPath);
      if (targetAbsPath.startsWith(path.resolve(extractDir))) {
        const findings = scanContentForCredentials(code, relPath);
        if (findings.length > 0) {
          blockedPatches.push({ file: relPath, findings });
          continue;
        }
        // Capture previous content BEFORE writing (enables rollback + diff stats)
        let previousContent = null;
        let isNewFile = true;
        try {
          if (fs.existsSync(targetAbsPath)) {
            previousContent = fs.readFileSync(targetAbsPath, 'utf8');
            isNewFile = false;
          }
        } catch (_) {}

        fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
        fs.writeFileSync(targetAbsPath, code, 'utf8');

        // Compute rough +/- line diff stats
        const newLines = code.split('\n').length;
        const oldLines = previousContent ? previousContent.split('\n').length : 0;
        const added = isNewFile ? newLines : Math.max(0, newLines - oldLines);
        const removed = isNewFile ? 0 : Math.max(0, oldLines - newLines);

        patches.push(relPath);
        patchesApplied.push({
          file: relPath,
          previousContent,
          isNewFile,
          added,
          removed
        });
      }
    }

    let patchesReport = '';
    if (patches.length > 0) {
      patchesReport += `\n\n**[AI Agent applied patches to files]:**\n${patches.map(p => ` - \`${p}\``).join('\n')}`;
    }
    if (blockedPatches.length > 0) {
      patchesReport += `\n\n⚠️ **[AI Agent Security Notice - Secret Leak Blocked]:**\nPatches to the following files were blocked because they contained hardcoded secrets:\n${blockedPatches.map(bp => ` - \`${bp.file}\``).join('\n')}`;
    }

    // 2. Parse Exec Commands
    const execRegex = /<exec\s+command="([^"]+)"\s*\/>/g;
    const commandsToRun = [];
    while ((match = execRegex.exec(assistantText)) !== null) {
      commandsToRun.push(match[1]);
    }

    if (commandsToRun.length === 0) {
      // ReAct Loop complete, no further actions needed!
      break;
    }

    // Sort into read-only, CUD, and unsafe
    const unsafeCommands = [];
    const readOnlyCommands = [];
    const cudCommands = [];

    for (const cmd of commandsToRun) {
      if (!isCommandSafe(cmd)) {
        unsafeCommands.push(cmd);
      } else if (isReadOnlyCommand(cmd)) {
        readOnlyCommands.push(cmd);
      } else {
        cudCommands.push(cmd);
      }
    }

    let guardrailReport = '';
    if (unsafeCommands.length > 0) {
      guardrailReport += `\n\n⚠️ **[AI Agent Security Notice - Execution Blocked]:**\nUnsafe commands were rejected by guardrails:\n${unsafeCommands.map(c => ` - \`${c}\``).join('\n')}`;
    }

    // Execute read-only commands immediately
    let iterationLogs = '';
    for (const cmd of readOnlyCommands) {
      iterationLogs += `\n$ ${cmd}\n`;
      const out = await runCommandInContainer(containerName, cmd);
      iterationLogs += out;
    }

    // Handle CUD commands depending on permission mode
    const execPermission = deployment.execPermission || 'ask';

    if (cudCommands.length > 0) {
      if (execPermission === 'never') {
        iterationLogs += `\n[Execution blocked: User has disabled command execution for this agent]\n`;
      } else if (execPermission === 'always') {
        for (const cmd of cudCommands) {
          iterationLogs += `\n$ ${cmd}\n`;
          const out = await runCommandInContainer(containerName, cmd);
          iterationLogs += out;
        }
      } else if (execPermission === 'ask') {
        // We MUST pause the loop and ask the user!
        pendingCommands = cudCommands;

        // Save current ReAct loop state to Redis so we can resume later
        await setWorkingMemory(chatId, 'react_loop_state', {
          iteration: currentIteration,
          history: reactHistory
        });

        // Break loop and return partial response
        let currentMessage = assistantText + patchesReport + guardrailReport;
        if (iterationLogs || executionLogs) {
          currentMessage += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${executionLogs}${iterationLogs}\`\`\``;
        }

        return {
          message: currentMessage,
          pendingExec: true,
          commands: pendingCommands,
          patches: patchesApplied,
          chatId
        };
      }
    }

    executionLogs += iterationLogs;

    // Feed terminal observation back into the loop
    if (iterationLogs || patches.length > 0 || unsafeCommands.length > 0) {
      const observationMsg = [];
      if (patches.length > 0) {
        observationMsg.push(`Applied patches to: ${patches.join(', ')}`);
      }
      if (unsafeCommands.length > 0) {
        observationMsg.push(`Unsafe commands blocked: ${unsafeCommands.join(', ')}`);
      }
      if (iterationLogs) {
        observationMsg.push(`Terminal output:\n${iterationLogs}`);
      }
      
      reactHistory.push({
        role: 'user',
        content: observationMsg.join('\n\n')
      });
    } else {
      // Loop is stable (no read-only output, no patches, no CUD commands to run)
      break;
    }

    currentIteration++;
  }

  // Wrap up final response text
  let finalMessage = finalResponseText;
  
  // Append patches report
  const patchRegexEnd = /<patch\s+file="([^"]+)">([\s\S]*?)<\/patch>/g;
  let matchesPatches = [];
  while ((match = patchRegexEnd.exec(finalMessage)) !== null) {
    matchesPatches.push(match[1]);
  }
  
  if (patchesApplied.length > 0) {
    // If not already explicitly mentioned in the text, append them
    if (!finalMessage.includes('[AI Agent applied patches to files]')) {
      finalMessage += `\n\n**[AI Agent applied patches to files]:**\n${patchesApplied.map(p => ` - \`${p.file}\``).join('\n')}`;
    }
  }

  if (executionLogs) {
    if (!finalMessage.includes('[AI Agent Terminal Output]')) {
      finalMessage += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${executionLogs}\`\`\``;
    }
  }

  // Persist Episodic memory
  await saveEpisodicMemory(chatId, 'user', userMessage);
  await saveEpisodicMemory(chatId, 'agent', finalMessage);

  return {
    message: finalMessage,
    pendingExec: false,
    commands: [],
    patches: patchesApplied,
    chatId
  };
};

module.exports = {
  runAgentChatLoop,
  runCommandInContainer
};
