import { config } from 'dotenv';
config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  acquireToken,
  addTokenToPool,
  getPoolInfo,
  getPoolStatus,
  getTotalCapacity,
  initAccountPool,
  loadAccounts,
  loginAndAddToken,
} from './auth.js';
import { settings } from './config.js';
import { handleOpenAICompletion, handleOpenAIImageGeneration } from './openai.js';
import { getModelPayload, getModels, handleOpenAIModels } from './models.js';
import { getQueueInfo } from './queue.js';
import { ensureWafSession, getWafSessionInfo } from './waf-session.js';

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '50mb' }));
app.use('/admin', express.static(join(__dirname, '..', 'frontend'), { extensions: ['html'] }));
app.get('/dashboard', (req, res) => res.redirect('/admin'));

app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path === '/favicon.ico' || req.path === '/healthz') return next();

  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${apiKey}`) return next();

  return res.status(401).json({ error: { message: 'Invalid API key' } });
});

function serviceStatus() {
  return {
    status: 'ok',
    version: '1.2.0',
    pool: getPoolInfo(),
    poolStatus: getPoolStatus(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
    waf: getWafSessionInfo(),
    config: {
      maxConcurrentPerToken: settings.maxConcurrentPerToken,
      accountMinIntervalMs: settings.accountMinIntervalMs,
      rateLimitBaseCooldownMs: settings.rateLimitBaseCooldownMs,
      rateLimitMaxCooldownMs: settings.rateLimitMaxCooldownMs,
    },
  };
}

app.post('/v1/chat/completions', handleOpenAICompletion);

app.post('/v1/images/generations', handleOpenAIImageGeneration);

app.get('/v1/models', async (req, res) => {
  const slot = acquireToken();
  if (!slot) return res.json(handleOpenAIModels([]));

  try {
    const modelList = await getModels(slot.token);
    res.json(handleOpenAIModels(modelList));
  } catch (err) {
    console.warn('Model list fallback:', err.message);
    res.json(handleOpenAIModels([]));
  } finally {
    slot.release();
  }
});

app.get('/v1/models/:modelId', (req, res) => {
  res.json(getModelPayload(req.params.modelId));
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', version: '1.2.0', waf: getWafSessionInfo() });
});

app.get('/readyz', (req, res) => {
  const status = getPoolStatus();
  const waf = getWafSessionInfo();
  const ready = status.available > 0 && waf.ready;
  res.status(ready ? 200 : 503).json({ ready, poolStatus: status, queue: getQueueInfo(), waf });
});

app.get('/', (req, res) => {
  res.json(serviceStatus());
});

app.get('/admin/api/stats', (req, res) => {
  res.json(serviceStatus());
});

app.post('/admin/api/waf/refresh', async (req, res) => {
  try {
    await ensureWafSession({ force: true });
    return res.json({ success: true, waf: getWafSessionInfo() });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message }, waf: getWafSessionInfo() });
  }
});

app.post('/admin/api/token/add', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: { message: 'token required' } });
  }
  try {
    const added = addTokenToPool(token);
    return res.json({ success: true, email: added.email });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/admin/api/token/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'email and password required' } });
  }
  try {
    const entry = await loginAndAddToken(email, password);
    return res.json({ success: true, email: entry.email });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

app.listen(settings.port, async () => {
  console.log(`Qwen 2API running on http://localhost:${settings.port}`);
  console.log(`Admin panel:    http://localhost:${settings.port}/admin`);
  console.log('OpenAI format: POST /v1/chat/completions');
  console.log('Models:        GET /v1/models');

  if (!process.env.API_KEY) {
    console.warn('\nWARNING: API_KEY is not set — /admin/api/* and the completion endpoints are UNAUTHENTICATED.\n' +
      '   Set API_KEY in .env before exposing this service on a public network.\n');
  }

  loadAccounts();
  await initAccountPool();

  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection:', err);
  });

  const wafInfo = getWafSessionInfo();
  if (wafInfo.ready) {
    console.log(`WAF cookies ready via ${wafInfo.source || 'cache'} (${wafInfo.cookieCount})`);
    if (wafInfo.mode === 'headless-browser' && (wafInfo.ageMs == null || wafInfo.ageMs > (wafInfo.refreshMs || 0))) {
      ensureWafSession({ force: false }).catch((err) => console.warn('WAF background refresh skipped:', err.message));
    }
  } else {
    console.warn('WAF cookies missing — launching headless browser to harvest...');
    ensureWafSession({ force: true }).catch((err) => {
      console.warn('WAF headless harvest failed on startup:', err.message);
      console.warn('Service will retry on the next request. Ensure the playwright image is used.');
    });
  }
});
