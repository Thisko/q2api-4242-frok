import { requestHeaders } from './headers.js';
import { settings } from './config.js';
import { modelCapabilitiesForMode, parseModelMode } from './model-modes.js';
import { isWafHtml, withWafCookieHeaders } from './waf-session.js';

const BASE_URL = 'https://chat.qwen.ai';
let cachedModels = null;
let cacheTime = 0;

const FALLBACK_MODELS = [
  { id: 'qwen3.6-plus', capabilities: { thinking: true, search: true, vision: true, image_gen: true } },
  { id: 'qwen3.5-flash', capabilities: { thinking: true, search: true } },
  { id: 'qwen-max', capabilities: { thinking: true, search: true } },
  { id: 'qwen-plus', capabilities: { thinking: true, search: true } },
  { id: 'qwen-turbo', capabilities: { search: true } },
];

async function fetchModels(token) {
  const headers = await withWafCookieHeaders({
    authorization: `Bearer ${token}`,
    ...requestHeaders(),
  });
  const res = await fetch(`${BASE_URL}/api/models`, { headers });
  const text = await res.text();
  if (isWafHtml(text)) {
    throw new Error('Model list blocked by Aliyun WAF');
  }
  const json = JSON.parse(text);
  return json.data || [];
}

export async function getModels(token) {
  if (cachedModels && Date.now() - cacheTime < settings.modelCacheTtlMs) return cachedModels;
  cachedModels = await fetchModels(token);
  cacheTime = Date.now();
  return cachedModels;
}

export function clearModelCache() {
  cachedModels = null;
  cacheTime = 0;
}

export function handleOpenAIModels(modelList) {
  const variants = [];
  const sourceModels = modelList.length ? modelList : FALLBACK_MODELS.map(m => ({
    id: m.id,
    info: {
      meta: {
        capabilities: {
          thinking: !!m.capabilities.thinking,
          search: !!m.capabilities.search,
          vision: !!m.capabilities.vision,
        },
        chat_type: [
          ...(m.capabilities.deep_research ? ['deep_research'] : []),
          ...(m.capabilities.image_gen ? ['t2i'] : []),
          ...(m.capabilities.video_gen ? ['t2v'] : []),
          ...(m.capabilities.web_dev ? ['web_dev'] : []),
          ...(m.capabilities.slides ? ['slides'] : []),
        ],
      },
    },
  }));

  for (const m of sourceModels) {
    const meta = m.info?.meta || {};
    const caps = meta.capabilities || {};
    const chatTypes = meta.chat_type || [];

    const has = {
      vision: !!caps.vision,
      thinking: !!caps.thinking,
      search: !!caps.search,
      deep_research: chatTypes.includes('deep_research'),
      image_gen: chatTypes.includes('t2i'),
      video_gen: chatTypes.includes('t2v'),
      web_dev: chatTypes.includes('web_dev'),
      slides: chatTypes.includes('slides'),
    };

    const base = { object: 'model', created: 1700000000, owned_by: 'qwen', capabilities: has };

    // Base model
    variants.push({ id: m.id, ...base });

    // Suffixed variants based on capabilities
    if (has.thinking)       variants.push({ id: m.id + '-thinking', ...base });
    if (has.deep_research)  variants.push({ id: m.id + '-deep-research', ...base });
    if (has.image_gen)      variants.push({ id: m.id + '-image', ...base });
    if (has.video_gen)      variants.push({ id: m.id + '-video', ...base });
    if (has.web_dev)        variants.push({ id: m.id + '-webdev', ...base });
    if (has.slides)         variants.push({ id: m.id + '-slides', ...base });
  }

  return { object: 'list', data: variants };
}

export function getModelPayload(modelId) {
  const mode = parseModelMode(modelId);
  return {
    id: mode.requestedModel,
    object: 'model',
    created: 1700000000,
    owned_by: 'qwen',
    base_model: mode.baseModel,
    mode: mode.mode,
    capabilities: modelCapabilitiesForMode(mode),
  };
}
