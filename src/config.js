function readInt(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

export const settings = {
  port: readInt('PORT', 3000, 1),
  maxConcurrentPerToken: readInt('MAX_CONCURRENT_PER_TOKEN', 1, 1),
  maxQueueSize: readInt('MAX_QUEUE_SIZE', 100, 0),
  queueTimeoutMs: readInt('QUEUE_TIMEOUT_MS', 30000, 1000),
  accountMinIntervalMs: readInt('ACCOUNT_MIN_INTERVAL_MS', 1200, 0),
  rateLimitBaseCooldownMs: readInt('RATE_LIMIT_BASE_COOLDOWN_MS', 10 * 60 * 1000, 1000),
  rateLimitMaxCooldownMs: readInt('RATE_LIMIT_MAX_COOLDOWN_MS', 60 * 60 * 1000, 1000),
  maxTokenErrors: readInt('MAX_TOKEN_ERRORS', 3, 1),
  modelCacheTtlMs: readInt('MODEL_CACHE_TTL_MS', 30 * 60 * 1000, 1000),
};
