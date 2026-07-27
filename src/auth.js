import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requestHeaders } from './headers.js';
import { settings } from './config.js';
import { isWafHtml, withWafCookieHeaders } from './waf-session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env');
const BASE_URL = 'https://chat.qwen.ai';
const accountPool = [];

function now() {
  return Date.now();
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

function isTokenExpired(token) {
  const decoded = decodeJWT(token);
  if (!decoded?.exp) return true;
  return decoded.exp * 1000 < now() + 5 * 60 * 1000;
}

function cooldownRemaining(entry) {
  return Math.max(0, (entry.rateLimitedUntil || 0) - now());
}

function isRateLimited(entry) {
  return cooldownRemaining(entry) > 0;
}

function nextAvailableAt(entry) {
  return Math.max(entry.rateLimitedUntil || 0, (entry.lastRequestStarted || 0) + settings.accountMinIntervalMs);
}

function statusFor(entry) {
  if (!entry.token) return 'missing_token';
  if (isTokenExpired(entry.token)) return 'expired';
  if (isRateLimited(entry)) return 'rate_limited';
  if (entry.errorCount >= settings.maxTokenErrors) return 'error';
  return 'valid';
}

function statusText(status) {
  return {
    valid: 'valid',
    rate_limited: 'rate limited',
    expired: 'expired',
    missing_token: 'missing token',
    error: 'too many errors',
  }[status] || status;
}

function createEntry({ email, password = null, token = null }) {
  const decoded = token ? decodeJWT(token) : null;
  return {
    email: email || decoded?.id || 'token-user',
    password,
    token,
    expiresAt: token ? (decoded?.exp || 0) * 1000 : 0,
    errorCount: 0,
    activeRequests: 0,
    rateLimitedUntil: 0,
    lastRequestStarted: 0,
    lastError: '',
    rateLimitStrikes: 0,
  };
}

function persistTokensToEnv() {
  try {
    const aliveTokens = accountPool.filter(t => t.token).map(t => t.token);
    if (aliveTokens.length === 0) return;

    const line = `QWEN_TOKENS=${aliveTokens.join(',')}`;
    const content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
    const lines = content ? content.split(/\r?\n/) : [];
    const index = lines.findIndex(item => item.startsWith('QWEN_TOKENS='));
    if (index === -1) {
      lines.push(line);
    } else {
      lines[index] = line;
    }
    writeFileSync(ENV_PATH, lines.join('\n'));
  } catch (err) {
    console.warn('Failed to persist tokens to .env:', err.message);
  }
}

export function loadAccounts() {
  accountPool.length = 0;

  const accountsStr = process.env.QWEN_ACCOUNTS?.trim();
  const tokensStr = process.env.QWEN_TOKENS?.trim();

  if (accountsStr) {
    for (const entry of accountsStr.split(',')) {
      const [email, ...passParts] = entry.trim().split(':');
      const password = passParts.join(':');
      if (email && password) accountPool.push(createEntry({ email, password }));
    }
  }

  if (tokensStr) {
    for (const token of tokensStr.split(',').map(t => t.trim()).filter(Boolean)) {
      accountPool.push(createEntry({ token }));
    }
  }

  if (accountPool.length === 0) {
    console.warn('No QWEN_ACCOUNTS or QWEN_TOKENS configured. Use /admin to add a token.');
  }
  return accountPool;
}

async function login(email, password) {
  const headers = await withWafCookieHeaders(requestHeaders());
  const res = await fetch(`${BASE_URL}/api/v1/auths/signin`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: sha256(password) }),
  });
  const text = await res.text();
  if (isWafHtml(text)) {
    throw new Error(`Login blocked by Aliyun WAF for ${email}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Login failed for ${email}: invalid JSON (${err.message})`);
  }
  if (!json.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(json)}`);
  return json.token;
}

async function ensureToken(entry) {
  if (entry.token && !isTokenExpired(entry.token)) return entry.token;

  if (!entry.password) {
    entry.errorCount++;
    entry.lastError = 'expired_no_password';
    throw new Error(`Token expired for ${entry.email}, no password to refresh`);
  }

  try {
    entry.token = await login(entry.email, entry.password);
    const decoded = decodeJWT(entry.token);
    entry.expiresAt = (decoded?.exp || 0) * 1000;
    entry.errorCount = 0;
    entry.lastError = '';
    entry.rateLimitedUntil = 0;
    entry.rateLimitStrikes = 0;
    console.log(`  Logged in: ${entry.email}, token expires ${new Date(entry.expiresAt).toISOString()}`);
    return entry.token;
  } catch (err) {
    entry.errorCount++;
    entry.lastError = err.message;
    throw err;
  }
}

export async function initAccountPool() {
  console.log(`Account pool: ${accountPool.length} account(s), max ${settings.maxConcurrentPerToken} concurrent each`);
  for (const entry of accountPool) {
    try {
      await ensureToken(entry);
    } catch (err) {
      console.warn(`  Failed to init ${entry.email}: ${err.message}`);
    }
  }
}

export function acquireToken() {
  const timestamp = now();
  const candidates = accountPool.filter(t =>
    statusFor(t) === 'valid' &&
    t.activeRequests < settings.maxConcurrentPerToken &&
    nextAvailableAt(t) <= timestamp
  );

  if (candidates.length === 0) return null;

  candidates.sort((a, b) =>
    a.activeRequests - b.activeRequests ||
    (a.lastRequestStarted || 0) - (b.lastRequestStarted || 0)
  );

  const chosen = candidates[0];
  chosen.activeRequests++;
  chosen.lastRequestStarted = timestamp;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenFailure(token, { statusCode, message = '' } = {}) {
  const entry = accountPool.find(t => t.token === token);
  if (!entry) return;

  entry.errorCount++;
  entry.lastError = message || (statusCode ? `HTTP ${statusCode}` : 'upstream_error');

  if (statusCode === 429) {
    entry.rateLimitStrikes = (entry.rateLimitStrikes || 0) + 1;
    const cooldown = Math.min(
      settings.rateLimitMaxCooldownMs,
      settings.rateLimitBaseCooldownMs * (2 ** Math.max(0, entry.rateLimitStrikes - 1))
    );
    entry.rateLimitedUntil = now() + cooldown;
    entry.lastError = `rate_limited_${Math.ceil(cooldown / 1000)}s`;
  } else if (statusCode === 401 || statusCode === 403) {
    entry.lastError = statusCode === 401 ? 'auth_error' : 'forbidden';
  }
}

export function reportTokenSuccess(token) {
  const entry = accountPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount = 0;
  entry.lastError = '';
  entry.rateLimitStrikes = 0;
}

export async function refreshToken(entry) {
  return ensureToken(entry);
}

export function addTokenToPool(tokenStr) {
  const token = tokenStr.trim();
  const existing = accountPool.find(t => t.token === token);
  if (existing) return existing;

  const entry = createEntry({ token });
  accountPool.push(entry);
  persistTokensToEnv();
  return entry;
}

export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  const existing = accountPool.find(t => t.email === email);
  const decoded = decodeJWT(token);

  if (existing) {
    existing.token = token;
    existing.expiresAt = (decoded?.exp || 0) * 1000;
    existing.errorCount = 0;
    existing.lastError = '';
    existing.rateLimitedUntil = 0;
    existing.rateLimitStrikes = 0;
    persistTokensToEnv();
    return existing;
  }

  const entry = createEntry({ email, password, token });
  accountPool.push(entry);
  persistTokensToEnv();
  return entry;
}

export function getPoolInfo() {
  return accountPool.map(t => {
    const status = statusFor(t);
    return {
      email: t.email,
      hasToken: !!t.token,
      expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
      errorCount: t.errorCount,
      activeRequests: t.activeRequests,
      maxConcurrent: settings.maxConcurrentPerToken,
      status,
      statusText: statusText(status),
      cooldownRemainingMs: cooldownRemaining(t),
      nextAvailableInMs: Math.max(0, nextAvailableAt(t) - now()),
      lastError: t.lastError || '',
    };
  });
}

export function getTotalCapacity() {
  return accountPool.filter(t => statusFor(t) === 'valid').length * settings.maxConcurrentPerToken;
}

export function getPoolStatus() {
  const statuses = getPoolInfo();
  return {
    total: statuses.length,
    available: statuses.filter(t => t.status === 'valid').length,
    rateLimited: statuses.filter(t => t.status === 'rate_limited').length,
    expired: statuses.filter(t => t.status === 'expired').length,
    error: statuses.filter(t => t.status === 'error').length,
    activeRequests: statuses.reduce((sum, t) => sum + t.activeRequests, 0),
    maxConcurrentPerToken: settings.maxConcurrentPerToken,
  };
}

export function getNextAvailableDelayMs() {
  const timestamp = now();
  const candidates = accountPool.filter(t =>
    t.token &&
    !isTokenExpired(t.token) &&
    t.errorCount < settings.maxTokenErrors &&
    t.activeRequests < settings.maxConcurrentPerToken
  );
  if (candidates.length === 0) return null;
  const nextTime = Math.min(...candidates.map(nextAvailableAt));
  return Math.max(0, nextTime - timestamp);
}
