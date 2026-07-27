import { randomUUID } from 'crypto';
import { chatHeaders, requestHeaders } from './headers.js';
import { reportTokenFailure, reportTokenSuccess } from './auth.js';
import { ensureWafSession, isWafHtml, withWafCookieHeaders } from './waf-session.js';

const BASE_URL = 'https://chat.qwen.ai';

async function readResponseText(res) {
  return res.text();
}

function parseJsonOrThrow(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error(`${label}: empty response`);
  if (isWafHtml(trimmed)) {
    throw new Error(`${label}: blocked by Aliyun WAF (got HTML challenge page instead of JSON)`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label}: invalid JSON (${err.message}). Body starts with: ${trimmed.slice(0, 120)}`);
  }
}

async function qwenFetch(url, options = {}, { retryOnWaf = true } = {}) {
  const headers = await withWafCookieHeaders({
    ...options.headers,
    'x-request-id': options.headers?.['x-request-id'] || randomUUID(),
  });

  const res = await fetch(url, {
    ...options,
    headers,
  });

  // For streaming responses we only inspect status/content-type first.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    if (!res.ok) {
      const text = await readResponseText(res);
      if (retryOnWaf && isWafHtml(text)) {
        await ensureWafSession({ force: true });
        return qwenFetch(url, options, { retryOnWaf: false });
      }
      throw new Error(`Upstream stream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  const text = await readResponseText(res);
  if (retryOnWaf && isWafHtml(text)) {
    await ensureWafSession({ force: true });
    return qwenFetch(url, options, { retryOnWaf: false });
  }

  return { res, text };
}

export async function createChat(token, model, chatMode = 't2t', signal) {
  const { res, text } = await qwenFetch(`${BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...requestHeaders({
        referer: 'https://chat.qwen.ai/c/new-chat',
      }),
    },
    body: JSON.stringify({
      title: '新建对话',
      models: [model],
      chat_mode: chatMode,
      chat_type: chatMode,
      timestamp: Date.now(),
      project_id: '',
    }),
    signal,
  });

  const json = parseJsonOrThrow(text, 'createChat');
  const chatId = json.data?.id;
  if (!chatId) {
    throw new Error(`Failed to create chat (HTTP ${res.status}): ${JSON.stringify(json)}`);
  }
  return chatId;
}

export async function completion({ token, model, messages, chatMode = 't2t', thinkingEnabled = true, searchEnabled = true, signal }) {
  const chatId = await createChat(token, model, chatMode, signal);
  const timestamp = Math.floor(Date.now() / 1000);

  const isSpecialMode = chatMode !== 't2t';
  const isImageMode = chatMode === 't2i';
  const isVideoMode = chatMode === 't2v';
  const isDeepResearch = chatMode === 'deep_research';

  const featureConfig = {
    thinking_enabled: isImageMode || isVideoMode ? false : thinkingEnabled,
    output_schema: 'phase',
    research_mode: isDeepResearch ? 'deep' : 'normal',
    auto_thinking: isImageMode || isVideoMode ? false : thinkingEnabled,
    thinking_mode: (isImageMode || isVideoMode || !thinkingEnabled) ? 'Disabled' : 'Auto',
    thinking_format: 'summary',
    auto_search: isImageMode || isVideoMode ? false : searchEnabled,
  };

  const body = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: chatMode,
    model,
    parent_id: null,
    messages: messages.map(msg => ({
      fid: randomUUID(),
      parentId: null,
      childrenIds: [randomUUID()],
      role: msg.role,
      content: msg.content,
      user_action: 'chat',
      files: [],
      timestamp,
      models: [model],
      chat_type: chatMode,
      feature_config: featureConfig,
      extra: { meta: { subChatType: chatMode } },
      sub_chat_type: chatMode,
      parent_id: null,
    })),
    timestamp,
  };

  const res = await qwenFetch(`${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: chatHeaders(token, chatId),
    body: JSON.stringify(body),
    signal,
  });

  // Streaming path returns the raw Response.
  if (res instanceof Response) {
    if (!res.ok) {
      const text = await res.text();
      reportTokenFailure(token, { statusCode: res.status, message: text.slice(0, 200) });
      if (isWafHtml(text)) {
        throw new Error('Completion blocked by Aliyun WAF (HTML challenge page)');
      }
      throw new Error(`Completion failed: ${res.status} ${text.slice(0, 200)}`);
    }
    reportTokenSuccess(token);
    return { body: res.body };
  }

  // Non-stream fallback (should not happen for completions).
  const { res: raw, text } = res;
  if (!raw.ok || isWafHtml(text)) {
    reportTokenFailure(token, { statusCode: raw.status, message: text.slice(0, 200) });
    if (isWafHtml(text)) throw new Error('Completion blocked by Aliyun WAF (HTML challenge page)');
    throw new Error(`Completion failed: ${raw.status} ${text.slice(0, 200)}`);
  }
  reportTokenSuccess(token);
  throw new Error(`Completion returned non-stream response: ${text.slice(0, 200)}`);
}

export async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPhaseStatus = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed['response.created'] || parsed['response.info']) continue;

          if (parsed.choices) {
            for (const choice of parsed.choices) {
              const delta = choice.delta;
              if (!delta) continue;

              const phase = delta.phase;
              const status = delta.status;
              const content = delta.content || '';
              const usage = parsed.usage;

              // Deduplicate: skip same phase+status combo
              const key = `${phase}:${status}`;
              if (key === lastPhaseStatus && status === 'typing' && !content) continue;
              lastPhaseStatus = key;

              if (status === 'finished' && phase === 'answer') {
                yield { type: 'done', usage };
                return;
              }

              // Image generation: content is the CDN URL
              if (phase === 'image_gen') {
                if (status === 'finished') continue;
                if (content) {
                  yield { type: 'image', content, usage };
                }
                continue;
              }

              // Deep research phases
              const researchPhases = ['ResearchNotice', 'ResearchPlanning', 'ResearchSearching', 'ResearchReading', 'Writing'];
              if (researchPhases.includes(phase)) {
                if (status === 'finished' && !content) continue;
                const extra = delta.extra || {};
                const drInfo = extra.deep_research || {};
                const stage = drInfo.stage || phase;
                if (content) {
                  yield { type: 'research', content, stage, usage };
                }
                continue;
              }

              // Thinking summary
              if (phase === 'thinking_summary') {
                if (status === 'finished') continue;
                const extra = delta.extra || {};
                const summaryTitle = extra.summary_title?.content?.join('') || '';
                const summaryThought = extra.summary_thought?.content?.join('') || '';
                const thinkingContent = summaryThought || summaryTitle || content;
                if (thinkingContent) {
                  yield { type: 'thinking', content: thinkingContent, usage };
                }
                continue;
              }

              // Regular answer
              if (phase === 'answer' && content) {
                yield { type: 'content', content, usage };
              }
            }
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
