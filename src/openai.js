import { completion, parseSSEStream } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';
import { parseModelMode } from './model-modes.js';

function isThinkingEnabled(model, forceThinking, enableThinking) {
  if (forceThinking) return true;
  if (enableThinking) return true;
  return false;
}

function isSearchEnabled(chatMode, enableSearch) {
  if (enableSearch) return true;
  if (chatMode === 'deep_research') return true;
  return false;
}

function buildQwenMessages(messages, chatMode) {
  const last = messages[messages.length - 1] || { role: 'user', content: '' };

  if (messages.length <= 1) {
    const msg = last;
    return [{
      role: 'user',
      content: msg.role === 'user'
        ? (typeof msg.content === 'string' ? msg.content : extractText(msg.content))
        : `${msg.role}:${typeof msg.content === 'string' ? msg.content : extractText(msg.content)}`,
    }];
  }

  const history = messages.slice(0, -1);
  const historyParts = history.map(m => {
    const text = typeof m.content === 'string' ? m.content : extractText(m.content);
    return `${m.role}:${text}`;
  }).join(';');

  const lastText = typeof last.content === 'string' ? last.content : extractText(last.content);
  const combinedText = historyParts ? `${historyParts};${last.role}:${lastText}` : `${last.role}:${lastText}`;

  return [{ role: 'user', content: combinedText }];
}

// Build the combined user message with tool-calling context. When tools are
// provided, assistant tool_calls and tool/function results are rendered so the
// model sees them as already-completed exchanges (preventing re-execution or
// echoing). Tool definitions + instructions are appended to the final message.
function buildQwenMessagesWithTools(messages, chatMode, tools, toolChoice) {
  const toolCallingEnabled = normalizeTools(tools).length > 0 && toolChoice !== 'none';
  if (!toolCallingEnabled) {
    const msgs = buildQwenMessages(messages, chatMode);
    return msgs;
  }

  const parts = [];
  let pendingToolCalls = [];
  for (const m of messages) {
    if (m.role === 'user') {
      parts.push(`[User]: ${textFromContent(m.content)}`);
    } else if (m.role === 'assistant') {
      const content = textFromContent(m.content);
      if (content) parts.push(`[Assistant]: ${content}`);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        pendingToolCalls.push(...m.tool_calls);
      }
    } else if (m.role === 'tool') {
      const name = m.name || m.tool_call_id || 'tool';
      const matched = pendingToolCalls.find(tc => tc.id === m.tool_call_id);
      const argSummary = matched?.function?.arguments || '';
      parts.push(`[Tool result already received — ${name}(${argSummary})]: ${textFromContent(m.content)}`);
      pendingToolCalls = pendingToolCalls.filter(tc => tc.id !== m.tool_call_id);
    } else if (m.role === 'system') {
      parts.push(`[System]: ${textFromContent(m.content)}`);
    } else if (m.role === 'function') {
      parts.push(`[Function result ${m.name || 'function'}]: ${textFromContent(m.content)}`);
    }
  }
  if (pendingToolCalls.length) {
    parts.push(`[Assistant previous tool calls (no result returned)]: ${JSON.stringify(pendingToolCalls)}`);
  }

  const combined = parts.join('\n\n') + buildToolInstructions(tools, toolChoice);
  return [{ role: 'user', content: combined.trim() }];
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  }
  return '';
}

// Full text extraction for tool-call history rendering (handles image_url, etc.)
function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'image_url') return '[Image]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

// ---- Tool-calling support (ported from deepseek-2api openai.js) ----

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      },
    }));
}

// Compact one-line signature, e.g. `get_weather(city: string)`.
// Keeps tool definitions tiny (vs pretty-printed JSON schemas) so that dozens
// of tools (Claude Code sends ~50) don't bloat the prompt or get echoed back.
function toolSignature(tool) {
  const fn = tool.function;
  const params = fn.parameters?.properties || {};
  const required = new Set(fn.parameters?.required || []);
  const parts = Object.entries(params).map(([k, v]) => {
    const t = v.type || 'any';
    return required.has(k) ? `${k}: ${t}` : `${k}?: ${t}`;
  });
  return `${fn.name}(${parts.join(', ')})${fn.description ? ` — ${fn.description}` : ''}`;
}

function toolChoiceInstruction(toolChoice, tools) {
  if (!toolChoice || toolChoice === 'auto') return 'Call a tool when it helps answer the question; otherwise answer directly.';
  if (toolChoice === 'required') return 'You must call at least one tool.';
  if (toolChoice === 'none') return 'Do not call any tool.';
  const forcedName = toolChoice?.function?.name;
  if (forcedName && tools.some(t => t.function.name === forcedName)) {
    return `You must call the tool named ${forcedName}.`;
  }
  return 'Call a tool when it helps answer the question; otherwise answer directly.';
}

function buildToolInstructions(tools, toolChoice) {
  const normalized = normalizeTools(tools);
  if (!normalized.length || toolChoice === 'none') return '';
  const sigs = normalized.map(toolSignature).join('\n');
  return `\n\n[Available tools]\n${sigs}\n\n${toolChoiceInstruction(toolChoice, normalized)}\n\nTo call a tool, output ONLY this block and nothing else (no prose, no markdown):\n<tool_calls>[{"name":"<tool_name>","arguments":{...}}]</tool_calls>\nThe array may contain multiple calls. "arguments" must be a JSON object. Do not wrap it in code fences. If no tool is needed, answer normally without the block.`;
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Best-effort repair of slightly malformed / truncated JSON tool-call output.
function repairJson(text) {
  let s = text.trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/[\u201c\u201d\u2018\u2019]/g, '"');
  const ok = tryParseJson(s);
  if (ok !== null) return ok;
  // Truncation recovery: append the closers needed to balance openers.
  let inStr = false, escape = false;
  const lastOpen = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') lastOpen.push(c);
    else if (c === '}' || c === ']') lastOpen.pop();
  }
  if (inStr) s += '"';
  while (lastOpen.length) {
    const op = lastOpen.pop();
    s += (op === '{') ? '}' : ']';
  }
  return tryParseJson(s);
}

function normalizeToolArguments(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '{}';
    const parsed = tryParseJson(trimmed);
    return parsed === null ? trimmed : JSON.stringify(parsed);
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

function toOpenAIToolCalls(calls) {
  return calls
    .map((call, index) => {
      const fn = call.function || call;
      const name = fn.name;
      if (!name || typeof name !== 'string') return null;
      return {
        id: call.id || `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: { name, arguments: normalizeToolArguments(fn.arguments ?? call.arguments ?? {}) },
      };
    })
    .filter(Boolean);
}

// Extract JSON inside the LAST <tag>...</tag> block (avoids half-opened tags).
function extractJsonBlock(text, tag) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lastClose = text.toLowerCase().lastIndexOf(close);
  if (lastClose === -1) return null;
  const lastOpen = text.toLowerCase().lastIndexOf(open, lastClose);
  if (lastOpen === -1) return null;
  const inner = text.slice(lastOpen + open.length, lastClose);
  const gt = inner.indexOf('>');
  const body = gt === -1 ? inner : inner.slice(gt + 1);
  const trimmed = body.trim();
  return trimmed || null;
}

function stripToolBlocks(text) {
  return text
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

function parseToolCallsFromText(text) {
  if (!text) return null;
  const candidates = [extractJsonBlock(text, 'tool_calls'), extractJsonBlock(text, 'tool_call')].filter(Boolean);
  for (const block of candidates) {
    const parsed = tryParseJson(block) ?? repairJson(block);
    if (!parsed) continue;
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: stripToolBlocks(text) };
  }
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const bare = tryParseJson(fenced) ?? repairJson(fenced);
  if (bare) {
    const rawCalls = bare.tool_calls || bare.tools || bare.calls || bare.function_call || bare;
    const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: '' };
  }
  if (/<tool_call/.test(text)) {
    console.error('Tool-call block detected but failed to parse:', JSON.stringify(text.slice(0, 300)));
  }
  return null;
}

// Stream tool_calls incrementally per the OpenAI streaming protocol.
const ARGS_CHUNK_SIZE = 24;
function streamToolCallsIncremental(res, writeOpts, toolCalls, writeSSE) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    writeSSE(res, {
      ...writeOpts,
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }],
    });
    const args = tc.function.arguments || '';
    for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
      writeSSE(res, {
        ...writeOpts,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }] }, finish_reason: null }],
      });
    }
  }
}

export async function handleOpenAICompletion(req, res) {
  const { model, messages, stream = false } = req.body;
  const tools = normalizeTools(req.body.tools);
  const toolChoice = req.body.tool_choice ?? 'auto';
  const toolCallingEnabled = tools.length > 0 && toolChoice !== 'none';
  // Clients (Claude Code, OpenAI SDK) request a final usage chunk via
  // stream_options.include_usage; emit it so they don't stall on accounting.
  const includeUsage = stream && req.body.stream_options?.include_usage === true;

  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: { message: 'model and messages are required' } });
  }

  const { baseModel, chatMode, forceThinking } = parseModelMode(model);
  const thinkingEnabled = isThinkingEnabled(model, forceThinking, req.body.enable_thinking);
  const searchEnabled = isSearchEnabled(chatMode, req.body.enable_search);
  const qwenMessages = buildQwenMessagesWithTools(messages, chatMode, req.body.tools, toolChoice);

  const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const abortController = new AbortController();
  let completed = false;
  let clientClosed = false;
  let result;

  // Only abort upstream when the client disconnects before we finish writing.
  // Listening to req 'close' is too aggressive: it can fire after the body is
  // fully received and kill in-flight Qwen requests.
  res.on('close', () => {
    if (!completed && !res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  try {
    const slot = await enqueueRequest();

    try {
      result = await completion({
        token: slot.token,
        model: baseModel,
        messages: qwenMessages,
        chatMode,
        thinkingEnabled,
        searchEnabled,
        signal: abortController.signal,
      });
      result.slot = slot;
    } catch (err) {
      slot.release();
      dispatchQueued();
      console.error('Completion error:', err.message);
      return res.status(500).json({ error: { message: err.message } });
    }
  } catch (err) {
    return res.status(503).json({ error: { message: err.message } });
  }

  const { body: streamBody, slot } = result;

  // Small helper to keep the streaming branches consistent.
  const writeSSE = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const baseOpts = () => ({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
      });

      writeSSE({
        ...baseOpts(),
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      // When tool-calling, buffer content so <tool_calls> blocks can be parsed
      // and emitted as proper tool_calls; thinking/research still stream live.
      let contentBuffer = '';
      let streamUsage = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (clientClosed || res.destroyed) break;
        if (event.type === 'content') {
          if (toolCallingEnabled) { contentBuffer += event.content; continue; }
          writeSSE({
            ...baseOpts(),
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          });
        } else if (event.type === 'thinking') {
          writeSSE({
            ...baseOpts(),
            choices: [{ index: 0, delta: { reasoning_content: event.content }, finish_reason: null }],
          });
        } else if (event.type === 'image') {
          if (toolCallingEnabled) { contentBuffer += event.content; continue; }
          writeSSE({
            ...baseOpts(),
            choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }],
          });
        } else if (event.type === 'research') {
          writeSSE({
            ...baseOpts(),
            choices: [{ index: 0, delta: { reasoning_content: `[${event.stage}] ${event.content}` }, finish_reason: null }],
          });
        } else if (event.type === 'done') {
          streamUsage = event.usage;
        }
      }
      if (clientClosed || res.destroyed) { if (!res.destroyed) res.end(); return; }

      const parsedToolCalls = toolCallingEnabled ? parseToolCallsFromText(contentBuffer) : null;
      if (parsedToolCalls?.toolCalls?.length) {
        streamToolCallsIncremental(res, baseOpts(), parsedToolCalls.toolCalls, writeSSE);
        writeSSE({
          ...baseOpts(),
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        // Flush buffered content when tool-calling was requested but the model
        // answered normally instead of emitting a tool_calls block.
        if (toolCallingEnabled && contentBuffer) {
          writeSSE({
            ...baseOpts(),
            choices: [{ index: 0, delta: { content: contentBuffer }, finish_reason: null }],
          });
        }
        writeSSE({
          ...baseOpts(),
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      if (includeUsage) {
        writeSSE({
          ...baseOpts(),
          choices: [],
          usage: {
            prompt_tokens: streamUsage?.input_tokens || 0,
            completion_tokens: streamUsage?.output_tokens || 0,
            total_tokens: (streamUsage?.input_tokens || 0) + (streamUsage?.output_tokens || 0),
          },
        });
      }
      res.write('data: [DONE]\n\n');
      if (!res.destroyed) res.end();
    } else {
      let fullContent = '';
      let fullThinking = '';
      let usage = null;

      for await (const event of parseSSEStream(streamBody)) {
        if (clientClosed || res.destroyed) break;
        if (event.type === 'content' || event.type === 'image') {
          fullContent += event.content;
        } else if (event.type === 'thinking' || event.type === 'research') {
          const prefix = event.type === 'research' ? `[${event.stage}] ` : '';
          fullThinking += prefix + event.content;
        } else if (event.type === 'done') {
          usage = event.usage;
        }
      }

      // Parse tool calls only from model output, never from thinking.
      const parsedToolCalls = toolCallingEnabled ? parseToolCallsFromText(fullContent) : null;
      const message = parsedToolCalls?.toolCalls?.length
        ? {
            role: 'assistant',
            content: parsedToolCalls.content || null,
            tool_calls: parsedToolCalls.toolCalls,
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
          }
        : {
            role: 'assistant',
            content: fullContent,
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
          };

      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: parsedToolCalls?.toolCalls?.length ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: usage?.input_tokens || 0,
          completion_tokens: usage?.output_tokens || 0,
          total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        },
      };
      completed = true;
      res.json(response);
    }
  } catch (err) {
    if (clientClosed || err.name === 'AbortError') return;
    console.error('Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  } finally {
    completed = true;
    slot.release();
    dispatchQueued();
  }
}


// ---- OpenAI-compatible image generation (/v1/images/generations) ----
// 复用底层 t2i chat 流：把 prompt 作为单条 user message 调用 completion(chatMode='t2i')，
// 收集所有 image 事件中的 CDN URL，按 OpenAI images 格式返回。
export async function handleOpenAIImageGeneration(req, res) {
  const {
    model = 'qwen-image',
    prompt,
    n = 1,
   size,
    response_format = 'b64_json',
   quality,
   style,
 } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: { message: 'prompt is required and must be a string' } });
  }

  // 解析模型：支持 qwen-image / qwen-plus-image / <base>-image / <base>-t2i 等后缀
  const { baseModel, chatMode } = parseModelMode(model);
  // 如果用户没带 -image 后缀，强制走 t2i；否则尊重解析出的 chatMode（非 t2i 也校正为 t2i）
  const effectiveChatMode = 't2i';
  const effectiveModel = baseModel || 'qwen-image';

  const requestId = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const abortController = new AbortController();
  let completed = false;
  let clientClosed = false;

  res.on('close', () => {
    if (!completed && !res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  // n=1 是单张；Qwen t2i 单次请求即出一张，n>1 时并发多次请求
  const count = Math.min(Math.max(parseInt(n, 10) || 1, 1), 10);
  const messages = [{ role: 'user', content: prompt }];

  async function generateOne() {
    const slot = await enqueueRequest();
    try {
      const result = await completion({
        token: slot.token,
        model: effectiveModel,
        messages,
        chatMode: effectiveChatMode,
        thinkingEnabled: false,
        searchEnabled: false,
        signal: abortController.signal,
      });
      const { body: streamBody } = result;
      const urls = [];
      let usage = null;
      for await (const event of parseSSEStream(streamBody)) {
        if (clientClosed || res.destroyed) break;
        if (event.type === 'image' && event.content) {
          urls.push(event.content);
        } else if (event.type === 'done') {
          usage = event.usage;
        }
      }
      return { urls, slot, usage };
    } catch (err) {
      return { urls: [], slot, error: err };
    }
  }

  try {
    const tasks = [];
    for (let i = 0; i < count; i++) tasks.push(generateOne());
    const results = await Promise.all(tasks);

    // 释放所有 slot
    for (const r of results) r.slot?.release?.();
    dispatchQueued();

    const errors = results.filter(r => r.error);
    if (errors.length === results.length) {
      // 全失败
      completed = true;
      return res.status(500).json({
        error: { message: errors[0].error?.message || 'image generation failed' },
      });
    }

    const images = [];
    for (const r of results) {
      for (const url of r.urls) {
        if (response_format === 'b64_json') {
          try {
            const imgRes = await fetch(url, { signal: abortController.signal });
            if (!imgRes.ok) throw new Error(`CDN fetch ${imgRes.status}`);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            images.push({ b64_json: buf.toString('base64'), revised_prompt: prompt });
          } catch (e) {
            // 下载失败则回退到 url
            images.push({ url, revised_prompt: prompt });
          }
        } else {
          images.push({ url, revised_prompt: prompt });
        }
      }
    }

    // 没拿到任何 URL 但也没全失败
    if (!images.length) {
      completed = true;
      return res.status(500).json({
        error: { message: 'image generation returned no images' },
      });
    }

    completed = true;
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images,
    });
  } catch (err) {
    if (clientClosed || err.name === 'AbortError') return;
    console.error('Image generation error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  }
}
