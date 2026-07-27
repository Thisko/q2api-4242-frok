import { config } from 'dotenv';
config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadAccounts, initAccountPool, getPoolInfo, getTotalCapacity, acquireToken } from './auth.js';
import { handleOpenAICompletion } from './openai.js';
import { getModels, handleOpenAIModels } from './models.js';
import { getQueueInfo } from './queue.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '50mb' }));

// Dashboard — static frontend
app.use('/dashboard', express.static(join(__dirname, '..', 'frontend'), { extensions: ['html'] }));

// API Key auth middleware (skip for dashboard)
app.use((req, res, next) => {
  if (req.path.startsWith('/dashboard') || req.path === '/favicon.ico') return next();

  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  const auth = req.headers['authorization'];
  if (auth === `Bearer ${apiKey}`) return next();

  res.status(401).json({ error: { message: 'Invalid API key' } });
});

// OpenAI format
app.post('/v1/chat/completions', handleOpenAICompletion);

// Models - temporarily acquire a slot just for the API call
app.get('/v1/models', async (req, res) => {
  const slot = acquireToken();
  if (!slot) return res.status(503).json({ error: { message: 'No available token' } });

  try {
    const modelList = await getModels(slot.token);
    res.json(handleOpenAIModels(modelList));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  } finally {
    slot.release();
  }
});

// Health check + pool info
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    pool: getPoolInfo(),
    totalCapacity: getTotalCapacity(),
    queue: getQueueInfo(),
  });
});

app.listen(PORT, async () => {
  console.log(`Qwen 2API running on http://localhost:${PORT}`);
  console.log(`Dashboard:      http://localhost:${PORT}/dashboard`);
  console.log(`OpenAI format:  POST /v1/chat/completions`);
  console.log(`Models:         GET /v1/models`);

  loadAccounts();
  await initAccountPool();
});
