const axios = require('axios');

/**
 * Checks if the LLM backend is available and has the required model.
 * If not, throws a descriptive error.
 */
const checkLLMAvailability = async (url, model, isOllama) => {
  if (!isOllama) return true; // Assume cloud APIs are available or fail on post

  // Normalize Ollama endpoint to obtain the base URL
  // e.g. http://localhost:11434/v1/chat/completions -> http://localhost:11434
  const baseUrl = url.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '');
  const tagsUrl = `${baseUrl}/api/tags`;

  try {
    const res = await axios.get(tagsUrl, { timeout: 3000 });
    const models = res.data?.models || [];
    const hasModel = models.some(m => 
      m.name === model || 
      m.name.startsWith(model + ':') || 
      model.startsWith(m.name)
    );
    if (!hasModel) {
      throw new Error(`Model '${model}' is not pulled or cached in local Ollama. Please run 'ollama pull ${model}'.`);
    }
    return true;
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message.includes('timeout')) {
      throw new Error(`Local Ollama is not running on ${baseUrl}. Start Ollama to use the Self-Healing Build Agent.`);
    }
    throw err;
  }
};

/**
 * Generate source file patches based on error logs and workspace state.
 * @param {string} errorLogs - Compilation/Build error logs.
 * @param {Object} workspaceFiles - Map of relative paths to file contents.
 * @param {Array} diagnoses - Array of diagnostic items from DevOps diagnostics engine.
 * @returns {Promise<string>} The raw LLM patch instructions response.
 */
const generateHealingPatches = async (errorLogs, workspaceFiles, diagnoses = []) => {
  const systemPrompt = `You are a Self-Healing Build Agent. Your task is to analyze build/compilation errors in a deployment pipeline and patch the project's source code or configuration files to resolve the issue.

You will be provided with:
1. The error logs from the failed build/compilation step.
2. A map of the current workspace files and their contents.
3. Diagnostic hints outlining potential issues and recommended fixes.

Identify the root cause of the compilation/build failure and patch the files.

CRITICAL RULES:
1. You must output your recommended file modifications. For each file you want to patch (modify or create), wrap the COMPLETE new file content inside a <patch> tag with a "file" attribute specifying the exact relative path of the file.
   Format:
   <patch file="relative/path/to/file.ext">
   // COMPLETE updated content of the file
   </patch>
2. The 'file' attribute MUST match the exact relative path of the file as listed in the workspace (e.g. if the file in the workspace is 'src/controllers/blogController.ts', the tag MUST be <patch file="src/controllers/blogController.ts">, NOT <patch file="blogController.ts">).
3. The content inside <patch> must be the full, complete drop-in replacement for the file. Do not use placeholders or omit unchanged code.
4. Only output the patches for files that need to be changed or created.

TypeScript/Compilation Specific Workarounds:
- WARNING: You are strictly limited by output token constraints. DO NOT ATTEMPT TO REWRITE MASSIVE SOURCE FILES (e.g., controllers or services over 100 lines). If you try to output a patch for a large controller file, your response will be truncated and the build will fail immediately.
- Instead, for ANY TypeScript compilation type errors, overload errors, missing properties, or library mismatches, you MUST modify the project's 'tsconfig.json' file to relax/disable strict compiler options under 'compilerOptions'. Set:
  "strict": false,
  "noEmitOnError": false,
  "skipLibCheck": true,
  "noImplicitAny": false,
  "strictNullChecks": false
- Under NO circumstances should you rewrite a source file to resolve type errors if it is larger than 100 lines. Focus entirely on modifying configuration files ('tsconfig.json', 'package.json') to bypass the issues.

---
FRAMEWORK-SPECIFIC DEBUGGING RECIPES:

1. JS/MERN Stack:
- Express 5 Wildcards: Path-to-regexp v8 throws 'Missing parameter name' for wildcard routes. Rename '/*' to '/*wildcard' or '/:wildcard*'.
- Mongoose Type Casting: For 'No overload matches this call' in Product/Blog find/update operations, cast queries/filters to 'any' or build them dynamically: e.g. 'const query: any = {}; query.category = req.query.category; await Product.find(query);'.

2. PHP/Laravel Stack:
- Platform Requirements: Bypassing php-version mismatches (e.g. requires php ^8.1 but version is 8.0) by updating dependencies in 'composer.json' or suggestions.
- DB Connections in Docker: Adjust 'DB_HOST=127.0.0.1' in '.env' or database configuration to 'host.docker.internal' or dynamic docker bridge settings to allow containerized communication with the DB engine.

3. Java Spring Boot Stack:
- Dependency Conflicts: Resolve missing package compile errors (e.g. hibernate/postgres driver) by adding correct maven/gradle dependencies inside 'pom.xml' or 'build.gradle'.
- Datasource Profiles: Relax datasource configurations in 'application.properties' or 'application.yml' (e.g. driver-class-name, jdbc postgres/mysql urls pointing to host.docker.internal).

4. Python Django/Flask Stack:
- Compilation Failures: Replace compiled packages in 'requirements.txt' with pre-compiled equivalents (e.g. replace 'psycopg2' with 'psycopg2-binary' to avoid missing pg_config compiler toolchains).
- DB Migrations: Ensure server entrypoint scripts execute migrations prior to launching (e.g. 'python manage.py migrate --noinput').

---
FEW-SHOT TEMPLATE ALIGNMENT EXAMPLES:

Example 1: TypeScript Overload Match Error (TS2769)
Error:
src/controllers/blogController.ts(742,42): error TS2769: No overload matches this call. Argument of type '{ author: string; }' is not assignable to 'FilterQuery<IBlog>'.
Fix Patch:
<patch file="src/controllers/blogController.ts">
import { Request, Response } from 'express';
import Blog from '../models/Blog';
export const getBlogsByAuthor = async (req: Request, res: Response) => {
  try {
    const filterQuery: any = { author: String(req.query.author) };
    const blogs = await Blog.find(filterQuery);
    return res.json(blogs);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
</patch>

Example 2: Express 5 Routing Path Wildcard Error
Error:
Error: Missing parameter name at index 16 in app.get('/api/files/*', fileHandler);
Fix Patch:
<patch file="server.js">
const express = require('express');
const app = express();
const fileHandler = (req, res) => res.json({ status: "file fetched" });
app.get('/api/files/*wildcard', fileHandler);
app.listen(process.env.PORT || 3000);
</patch>

Example 3: Missing package.json dependencies
Error:
Error: Cannot find module 'bcryptjs'
Fix Patch:
<patch file="package.json">
{
  "name": "healed-app",
  "version": "1.0.0",
  "dependencies": {
    "express": "^5.0.0",
    "bcryptjs": "^2.4.3"
  }
}
</patch>`;

  // Format the workspace files for LLM prompt context
  let filesText = '';
  for (const [filePath, content] of Object.entries(workspaceFiles)) {
    filesText += `--- FILE: ${filePath} ---\n${content}\n\n`;
  }

  // Format diagnostics hints
  let diagnosesHint = '';
  if (diagnoses && diagnoses.length > 0) {
    diagnosesHint = `### DEVOPS DIAGNOSTIC HINTS (POTENTIAL SOLUTIONS):
`;
    for (const diag of diagnoses) {
      diagnosesHint += `- **Detected Issue:** ${diag.error}
  **Solution Recommendation:** ${diag.solution}
`;
    }
    diagnosesHint += '\n';
  }

  const userPrompt = `${diagnosesHint}### ERROR LOGS:
${errorLogs}

### WORKSPACE FILES:
${filesText}`;

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
    console.log(`[LLM SERVICE] Routing to Groq Cloud using model: ${model}`);
  } else if (hfKey && hfKey.trim() !== '') {
    url = 'https://api-inference.huggingface.co/v1/chat/completions';
    headers['Authorization'] = `Bearer ${hfKey}`;
    model = process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct';
    console.log(`[LLM SERVICE] Routing to Hugging Face Cloud using model: ${model}`);
  } else {
    // Fallback to local Ollama API conforming to OpenAI spec
    const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    url = `${ollamaHost}/v1/chat/completions`;
    model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
    isOllama = true;
    console.log(`[LLM SERVICE] Routing to Local Ollama (${ollamaHost}) using model: ${model}`);
  }

  // Pre-check backend liveness and model caching to fail gracefully/early
  await checkLLMAvailability(url, model, isOllama);

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1
  };

  // Configure larger context window locally for Ollama
  if (isOllama) {
    payload.options = {
      num_ctx: 32768
    };
  }

  try {
    const response = await axios.post(url, payload, { headers, timeout: 90000 });
    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error(`Unrecognized completions response structure from LLM provider.`);
    }
  } catch (error) {
    const errMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`LLM call failed: ${errMsg}`);
  }
};

module.exports = { generateHealingPatches };
