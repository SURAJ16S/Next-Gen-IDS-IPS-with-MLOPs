const path = require('path');
const fs = require('fs');
const axios = require('axios');
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

// Import modular helper utilities
const {
  getFlatWorkspaceFiles,
  isCommandSafe,
  isReadOnlyCommand,
  runCommandInContainer,
  sanitizeTerminalLogs
} = require('./agent/helpers');

// Import modular system prompt generator
const { generateSystemPrompt } = require('./agent/prompt');

// Import Prometheus metrics
const {
  llmRequestsTotal,
  llmResponseDurationSeconds,
  agentLoopIterationsTotal,
  agentLoopErrorsTotal,
  agentPatchesAppliedTotal
} = require('./agent/metrics');

/**
 * Run the ReAct Agent Loop
 */
const runAgentChatLoop = async (deployment, chatSession, userMessage, resumeLogs = null, username = 'Anonymous', imageBase64 = null, imageMimeType = 'image/jpeg') => {
  if (!global.activeAgentLoops) {
    global.activeAgentLoops = 0;
  }
  global.activeAgentLoops++;

  try {
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
    
    // Construct dynamic system prompt using modular generator
    const systemPrompt = generateSystemPrompt(deployment, pkgDetails, flatFilesList);

    // Setup episodic memory and history
    let reactHistory = [];
    let currentIteration = 1;
    const maxIterations = 10;

    // Retrieve relevant episodic memories (semantic context)
    const episodicMemories = await getRelevantHistory(chatId, userMessage, 3);
    let formattedSemantic = [];
    if (episodicMemories.length > 0) {
      const memoryBlocks = episodicMemories.map(m => `[Session Role: ${m.role}]\nContent:\n${m.content}`).join('\n\n---\n\n');
      formattedSemantic = [{
        role: 'system',
        content: `The following is historical reference context from past sessions. Use this only for patterns or reference. Do NOT confuse this with the user's active prompt:\n\n${memoryBlocks}`
      }];
    }

    // ReAct memory state checks
    const existingState = await getWorkingMemory(chatId, 'react_loop_state');
    if (existingState && resumeLogs !== null) {
      currentIteration = existingState.iteration;
      reactHistory = existingState.history;
      
      // Feed resume execution output back into the loop
      reactHistory.push({
        role: 'user',
        content: `OBSERVATION (Execution Resumed):\nCommand execution completed.\nOutput:\n${resumeLogs}\n\n→ What do you conclude? Please start your response with a brief <reflect>...</reflect> block before taking any further action.`
      });
      
      // Clear state
      await deleteWorkingMemory(chatId, 'react_loop_state');
    } else {
      // Fresh start - load previous thread message history first
      if (chatSession && chatSession.messages && chatSession.messages.length > 0) {
        for (const msg of chatSession.messages) {
          const role = msg.role === 'agent' ? 'assistant' : 'user';
          reactHistory.push({
            role,
            content: msg.text
          });
        }
      }
      // Build the initial user message — multimodal if image is attached
      if (imageBase64) {
        reactHistory.push({
          role: 'user',
          content: [
            { type: 'text', text: userMessage },
            { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } }
          ]
        });
      } else {
        reactHistory.push({
          role: 'user',
          content: userMessage
        });
      }
    }

    let finalResponseText = '';
    let pendingCommands = [];
    let patchesApplied = [];
    let executionLogs = '';

    // Setup LLM routing details
    let url = '';
    let headers = { 'Content-Type': 'application/json' };
    let model = '';
    let isOllama = false;

    const groqKey = process.env.GROQ_API_KEY;
    const hfKey = process.env.HUGGINGFACE_API_KEY;

    if (groqKey) {
      url = 'https://api.groq.com/openai/v1/chat/completions';
      headers['Authorization'] = `Bearer ${groqKey}`;
      // Use vision-capable model when image is attached; fall back to coder model for text-only
      model = imageBase64
        ? (process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct')
        : (process.env.GROQ_MODEL || 'qwen-2.5-coder-32b');
      if (imageBase64) console.log(`[AGENT LOOP] Image attached — switching to vision model: ${model}`);
    } else if (hfKey) {
      url = 'https://api-inference.huggingface.co/v1/chat/completions';
      headers['Authorization'] = `Bearer ${hfKey}`;
      model = imageBase64
        ? (process.env.HF_VISION_MODEL || 'Qwen/Qwen2.5-VL-7B-Instruct')
        : (process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct');
    } else {
      const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
      url = `${ollamaHost}/v1/chat/completions`;
      model = imageBase64
        ? (process.env.OLLAMA_VISION_MODEL || 'llava:7b')
        : (process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b');
      isOllama = true;
    }

    while (currentIteration <= maxIterations) {
      console.log(`[REACT LOOP] Iteration ${currentIteration}/${maxIterations} for session ${chatId}`);
      
      // Track iterations completed
      agentLoopIterationsTotal.inc({ jobId: deployment.jobId, techStack: deployment.techStackDetected || 'MERN' });

      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...formattedSemantic,
          ...reactHistory
        ],
        temperature: 0.3,
        max_tokens: 4096,
        stream: true // Enable streaming for token-by-token responses
      };

      if (isOllama) {
        payload.options = { 
          num_ctx: 32768,
          num_predict: 4096,
          temperature: 0.3
        };
      }

      let assistantText = '';
      const llmStart = Date.now();
      try {
        const response = await axios.post(url, payload, { 
          headers, 
          responseType: 'stream',
          timeout: 90000 
        });
        const stream = response.data;
        
        assistantText = await new Promise((resolve, reject) => {
          let accumulated = '';
          let buffer = '';
          
          stream.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let lines = buffer.split('\n');
            // Keep the last partial line in the buffer
            buffer = lines.pop();
            
            for (let line of lines) {
              line = line.trim();
              if (!line) continue;
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(dataStr);
                  const content = parsed.choices[0]?.delta?.content || '';
                  if (content) {
                    accumulated += content;
                    // Emit each token chunk to client via WebSocket
                    try {
                      const io = require('../websocket/socket').getIO();
                      io.emit(`agent:token:${deployment._id}`, {
                        chatId,
                        token: content
                      });
                    } catch (_) {}
                  }
                } catch (e) {
                  // Ignore parse errors on incomplete chunk boundaries
                }
              }
            }
          });
          
          stream.on('end', () => {
            // Process final buffer if any
            if (buffer && buffer.trim().startsWith('data: ')) {
              const dataStr = buffer.trim().slice(6).trim();
              if (dataStr !== '[DONE]') {
                try {
                  const parsed = JSON.parse(dataStr);
                  const content = parsed.choices[0]?.delta?.content || '';
                  accumulated += content;
                } catch (_) {}
              }
            }
            resolve(accumulated);
          });
          
          stream.on('error', err => reject(err));
        });

        // Track successful LLM call metrics
        llmRequestsTotal.inc({ model, techStack: deployment.techStackDetected || 'MERN', status: 'success' });
        const durationSec = (Date.now() - llmStart) / 1000;
        llmResponseDurationSeconds.observe({ model, techStack: deployment.techStackDetected || 'MERN' }, durationSec);

        // Calculate and track token metrics
        const promptText = systemPrompt + formattedSemantic.map(m => m.content).join('') + reactHistory.map(m => m.content).join('');
        const computedPromptTokens = Math.ceil(promptText.length / 4);
        const computedCompletionTokens = Math.ceil(assistantText.length / 4);
        const computedTotalTokens = computedPromptTokens + computedCompletionTokens;
        const speed = durationSec > 0 ? parseFloat((computedCompletionTokens / durationSec).toFixed(1)) : 0;

        const { llmPromptTokensTotal, llmCompletionTokensTotal, llmTokenSpeedGauges } = require('./agent/metrics');
        if (llmPromptTokensTotal) llmPromptTokensTotal.inc({ model }, computedPromptTokens);
        if (llmCompletionTokensTotal) llmCompletionTokensTotal.inc({ model }, computedCompletionTokens);
        if (llmTokenSpeedGauges) llmTokenSpeedGauges.set({ model }, speed);

        // Persist token usage record in Mongoose database
        try {
          const AgentTokenUsage = require('../models/AgentTokenUsage');
          await AgentTokenUsage.findOneAndUpdate(
            { chatId },
            {
              $inc: { 
                promptTokens: computedPromptTokens, 
                completionTokens: computedCompletionTokens, 
                totalTokens: computedTotalTokens,
                requestCount: 1
              },
              $set: {
                jobId: deployment.jobId,
                techStack: deployment.techStackDetected || 'MERN',
                avgSpeed: speed,
                username: username || 'Anonymous'
              }
            },
            { upsert: true, new: true }
          );
        } catch (dbErr) {
          console.error('[DATABASE ERROR] Failed to record token usage:', dbErr.message);
        }

      } catch (llmError) {
        console.error('[REACT LOOP] LLM call error:', llmError.message);
        
        // Track failed LLM call metrics
        llmRequestsTotal.inc({ model, techStack: deployment.techStackDetected || 'MERN', status: 'error' });
        agentLoopErrorsTotal.inc({ jobId: deployment.jobId, errorType: 'llm_call_failed' });

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

      // Emit real-time thoughts to the client
      try {
        const io = require('../websocket/socket').getIO();
        io.emit(`agent:thinking:${deployment._id}`, {
          chatId,
          assistantText: sanitizeTerminalLogs(assistantText),
          executionLogs: sanitizeTerminalLogs(executionLogs),
          iteration: currentIteration,
          isComplete: false
        });
      } catch (socketErr) {
        // Ignore
      }

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
          if (trimmedCode.endsWith('```')) {
            trimmedCode = trimmedCode.substring(0, trimmedCode.length - 3).trim();
          }
        } else {
          trimmedCode = code;
        }

        // Credentials scan guardrail
        const scanResult = scanContentForCredentials(trimmedCode, relPath);
        if (scanResult.containsSecrets) {
          blockedPatches.push({ file: relPath, reason: scanResult.reason });
          agentLoopErrorsTotal.inc({ jobId: deployment.jobId, errorType: 'credential_leak_blocked' });
          continue;
        }

        const fullFilePath = path.join(extractDir, relPath);
        
        // Safety check: ensure file path stays within builds directory boundaries
        const resolved = path.resolve(fullFilePath);
        if (!resolved.startsWith(WORKSPACE_DIR)) {
          agentLoopErrorsTotal.inc({ jobId: deployment.jobId, errorType: 'path_traversal_blocked' });
          continue;
        }

        try {
          fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
          
          let previousContent = null;
          let isNewFile = true;
          if (fs.existsSync(fullFilePath)) {
            previousContent = fs.readFileSync(fullFilePath, 'utf8');
            isNewFile = false;
          }

          fs.writeFileSync(fullFilePath, trimmedCode, 'utf8');
          
          // Calculate diff lines added/removed
          const prevLines = previousContent ? previousContent.split('\n') : [];
          const newLines = trimmedCode.split('\n');
          const addedCount = newLines.length - prevLines.filter(l => newLines.includes(l)).length;
          const removedCount = prevLines.length - newLines.filter(l => prevLines.includes(l)).length;

          patches.push(relPath);
          patchesApplied.push({
            file: relPath,
            previousContent,
            isNewFile,
            added: addedCount,
            removed: removedCount
          });

          // Track patch written metric
          agentPatchesAppliedTotal.inc({ jobId: deployment.jobId, fileName: relPath });

        } catch (err) {
          console.error(`[PATCH ERROR] Failed to patch ${relPath}:`, err.message);
          agentLoopErrorsTotal.inc({ jobId: deployment.jobId, errorType: 'patch_write_failed' });
        }
      }

      let patchesReport = '';
      if (patches.length > 0) {
        patchesReport += `\n\n**[AI Agent applied patches to files]:**\n${patches.map(p => ` - \`${p}\``).join('\n')}`;
      }
      if (blockedPatches.length > 0) {
        patchesReport += `\n\n⚠️ **[AI Agent Security Notice - Credentials Blocked]:**\nSaving blocked for paths to prevent credentials leak:\n${blockedPatches.map(bp => ` - \`${bp.file}\` (${bp.reason})`).join('\n')}`;
      }

      // 2. Process Commands
      const commandsToRun = [];
      const execRegex = /<exec\s+command="([^"]+)"\s*\/>/g;
      while ((match = execRegex.exec(assistantText)) !== null) {
        commandsToRun.push(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
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
        agentLoopErrorsTotal.inc({ jobId: deployment.jobId, errorType: 'unsafe_command_blocked' });
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
            const logsFormatted = `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${executionLogs}${iterationLogs}\`\`\``;
            if (currentMessage.includes('</thought>')) {
              currentMessage = currentMessage.replace('</thought>', `${logsFormatted}\n</thought>`);
            } else if (currentMessage.includes('</thinking>')) {
              currentMessage = currentMessage.replace('</thinking>', `${logsFormatted}\n</thinking>`);
            } else {
              currentMessage += `\n\n<thought>${logsFormatted}</thought>`;
            }
          }

          try {
            const io = require('../websocket/socket').getIO();
            io.emit(`agent:thinking:${deployment._id}`, {
              chatId,
              assistantText: sanitizeTerminalLogs(currentMessage),
              executionLogs: sanitizeTerminalLogs(executionLogs + iterationLogs),
              isComplete: true
            });
          } catch (socketErr) {
            // Ignore
          }

          return {
            message: sanitizeTerminalLogs(currentMessage),
            pendingExec: true,
            commands: pendingCommands,
            patches: patchesApplied,
            chatId
          };
        }
      }

      executionLogs += iterationLogs;

      // Emit updated terminal logs to the client
      try {
        const io = require('../websocket/socket').getIO();
        io.emit(`agent:thinking:${deployment._id}`, {
          chatId,
          assistantText: sanitizeTerminalLogs(assistantText),
          executionLogs: sanitizeTerminalLogs(executionLogs),
          iteration: currentIteration,
          isComplete: false
        });
      } catch (socketErr) {
        // Ignore
      }

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
          content: `OBSERVATION (Iteration ${currentIteration}):\n` + 
                   observationMsg.join('\n\n') + 
                   `\n\n→ What do you conclude? Please start your response with a brief <reflect>...</reflect> block before taking any further action.`
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
        const logsFormatted = `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${executionLogs}\`\`\``;
        if (finalMessage.includes('</thought>')) {
          finalMessage = finalMessage.replace('</thought>', `${logsFormatted}\n</thought>`);
        } else if (finalMessage.includes('</thinking>')) {
          finalMessage = finalMessage.replace('</thinking>', `${logsFormatted}\n</thinking>`);
        } else {
          finalMessage += `\n\n<thought>${logsFormatted}</thought>`;
        }
      }
    }

    // Emit final response complete to client
    try {
      const io = require('../websocket/socket').getIO();
      io.emit(`agent:thinking:${deployment._id}`, {
        chatId,
        assistantText: sanitizeTerminalLogs(finalMessage),
        executionLogs: sanitizeTerminalLogs(executionLogs),
        isComplete: true
      });
    } catch (socketErr) {
      // Ignore
    }

    // Persist Episodic memory (save clean memories without leakage too)
    await saveEpisodicMemory(chatId, 'user', userMessage);
    await saveEpisodicMemory(chatId, 'agent', sanitizeTerminalLogs(finalMessage));

    return {
      message: sanitizeTerminalLogs(finalMessage),
      pendingExec: false,
      commands: [],
      patches: patchesApplied,
      chatId
    };
  } finally {
    global.activeAgentLoops = Math.max(0, global.activeAgentLoops - 1);
  }
};

module.exports = {
  runAgentChatLoop,
  runCommandInContainer
};
