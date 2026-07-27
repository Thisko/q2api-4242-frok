import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PROFILE_DIR = resolve(process.env.WAF_PROFILE_DIR || resolve(ROOT, 'chrome-profile-waf'));
const CACHE_FILE = resolve(process.env.WAF_COOKIE_CACHE || resolve(ROOT, 'data', 'waf-cookies.json'));
const HARVEST_SCRIPT = resolve(__dirname, 'waf-harvest.mjs');
const REFRESH_MS = Number.parseInt(process.env.WAF_COOKIE_REFRESH_MS || '', 10) || 20 * 60 * 1000;
const WARMUP_MS = Number.parseInt(process.env.WAF_COOKIE_WARMUP_MS || '', 10) || 5000;
// Default OFF: no Playwright. Enable only when you explicitly want browser harvest.
const AUTO_HARVEST = ['1', 'true', 'yes', 'on'].includes(String(process.env.WAF_AUTO_HARVEST || '').toLowerCase());
const REQUIRED_COOKIES = ['ssxmod_itna', 'tfstk', 'acw_tc'];

mkdirSync(dirname(CACHE_FILE), { recursive: true });
if (AUTO_HARVEST) mkdirSync(PROFILE_DIR, { recursive: true });

const state = {
  cookieHeader: '',
  cookies: [],
  refreshedAt: 0,
  lastError: '',
  source: '',
  refreshing: null,
};

function cookieHeaderFromList(cookies) {
  return cookies
    .filter((c) => c?.name && c?.value != null)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function normalizeCookies(input) {
  if (!input) return [];

  if (typeof input === 'string') {
    const header = input.trim();
    if (!header) return [];
    // Support raw Cookie header: "a=b; c=d"
    return header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain: '.qwen.ai',
      };
    }).filter(Boolean);
  }

  if (Array.isArray(input)) {
    return input
      .map((c) => {
        if (!c) return null;
        if (typeof c === 'string') {
          const idx = c.indexOf('=');
          if (idx <= 0) return null;
          return { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim(), domain: '.qwen.ai' };
        }
        if (c.name && c.value != null) {
          return {
            name: String(c.name),
            value: String(c.value),
            domain: c.domain || '.qwen.ai',
            path: c.path || '/',
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (typeof input === 'object') {
    if (Array.isArray(input.cookies)) return normalizeCookies(input.cookies);
    if (typeof input.cookie === 'string') return normalizeCookies(input.cookie);
    if (typeof input.cookieHeader === 'string') return normalizeCookies(input.cookieHeader);
    // map form: { ssxmod_itna: '...', tfstk: '...' }
    return Object.entries(input)
      .filter(([k, v]) => k && v != null && !['refreshedAt', 'source'].includes(k))
      .map(([name, value]) => ({ name, value: String(value), domain: '.qwen.ai' }));
  }

  return [];
}

function hasRequiredCookies(cookies) {
  const names = new Set((cookies || []).map((c) => c.name));
  return REQUIRED_COOKIES.every((name) => names.has(name));
}

function missingRequired(cookies) {
  const names = new Set((cookies || []).map((c) => c.name));
  return REQUIRED_COOKIES.filter((name) => !names.has(name));
}

function applyCookies(cookies, { refreshedAt = Date.now(), source = 'import', persist = true } = {}) {
  const normalized = normalizeCookies(cookies);
  if (!hasRequiredCookies(normalized)) {
    throw new Error(
      `WAF cookies incomplete, missing: ${missingRequired(normalized).join(', ') || '(all)'}`
    );
  }
  state.cookies = normalized;
  state.cookieHeader = cookieHeaderFromList(normalized);
  state.refreshedAt = refreshedAt;
  state.source = source;
  state.lastError = '';
  if (persist) {
    try {
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ refreshedAt, source, cookies: normalized }, null, 2)
      );
    } catch (err) {
      console.warn('Failed to persist WAF cookies:', err.message);
    }
  }
  console.log(
    `WAF session ready via ${source} (${normalized.length} cookies: ${normalized.map((c) => c.name).join(', ')})`
  );
  return state.cookieHeader;
}

function loadFromEnv() {
  const rawJson = process.env.WAF_COOKIES_JSON?.trim();
  const rawHeader = process.env.WAF_COOKIE?.trim() || process.env.WAF_COOKIES?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      return applyCookies(parsed, { source: 'env:WAF_COOKIES_JSON', persist: true });
    } catch (err) {
      state.lastError = `Invalid WAF_COOKIES_JSON: ${err.message}`;
    }
  }
  if (rawHeader) {
    return applyCookies(rawHeader, { source: 'env:WAF_COOKIE', persist: true });
  }
  return null;
}

function loadCachedCookies({ ignoreAge = false } = {}) {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    const cookies = normalizeCookies(raw);
    if (!cookies.length || !hasRequiredCookies(cookies)) return null;
    const refreshedAt = raw.refreshedAt || Date.now();
    const age = Date.now() - refreshedAt;
    // External cookies are reused until WAF fails or user replaces them.
    // Age limit only applies when auto-harvest is enabled.
    if (!ignoreAge && AUTO_HARVEST && REFRESH_MS > 0 && age > REFRESH_MS) return null;
    return applyCookies(cookies, {
      refreshedAt,
      source: raw.source || 'cache',
      persist: false,
    });
  } catch {
    return null;
  }
}

function runHarvestChild() {
  return new Promise((resolve, reject) => {
    if (!existsSync(HARVEST_SCRIPT)) {
      reject(new Error('waf-harvest.mjs not found'));
      return;
    }
    const child = spawn(
      process.execPath,
      [HARVEST_SCRIPT, PROFILE_DIR, String(WARMUP_MS)],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`WAF harvest timed out. stderr=${stderr.slice(0, 300)}`));
    }, 90000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`WAF harvest exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop());
        if (!parsed?.ok || !Array.isArray(parsed.cookies)) {
          reject(new Error(`WAF harvest bad payload: ${stdout.slice(0, 300)}`));
          return;
        }
        resolve(parsed.cookies);
      } catch (err) {
        reject(new Error(`WAF harvest parse failed: ${err.message}; out=${stdout.slice(0, 300)}`));
      }
    });
  });
}

async function harvestWithOptionalPlaywright() {
  if (!AUTO_HARVEST) {
    throw new Error(
      'No valid WAF cookies. Import browser cookies via POST /admin/api/waf/import or set WAF_COOKIE / data/waf-cookies.json. ' +
      'Playwright auto-harvest is disabled (set WAF_AUTO_HARVEST=1 only if you intentionally install playwright).'
    );
  }
  try {
    await import('playwright');
  } catch {
    throw new Error(
      'WAF_AUTO_HARVEST=1 but playwright is not installed. Prefer external cookie import for lightweight deploy.'
    );
  }
  const cookies = await runHarvestChild();
  return applyCookies(cookies, { source: 'playwright-harvest', persist: true });
}

async function refreshWafSession({ force = false } = {}) {
  try {
    // Always prefer external/env/file cookies first.
    const fromEnv = loadFromEnv();
    if (fromEnv) return fromEnv;

    const cached = loadCachedCookies({ ignoreAge: force || !AUTO_HARVEST });
    if (cached) return cached;

    return await harvestWithOptionalPlaywright();
  } catch (err) {
    state.lastError = err.message || String(err);
    console.warn('WAF session refresh failed:', state.lastError);
    throw err;
  }
}

export async function ensureWafSession({ force = false } = {}) {
  if (!force) {
    if (state.cookieHeader && (!AUTO_HARVEST || Date.now() - state.refreshedAt < REFRESH_MS || REFRESH_MS <= 0)) {
      return state.cookieHeader;
    }
    if (state.cookieHeader && AUTO_HARVEST && Date.now() - state.refreshedAt < REFRESH_MS) {
      return state.cookieHeader;
    }
    const warmed = loadFromEnv() || loadCachedCookies({ ignoreAge: !AUTO_HARVEST });
    if (warmed) return warmed;
  } else if (!AUTO_HARVEST) {
    // Force without playwright: reload external sources only.
    const reloaded = loadFromEnv() || loadCachedCookies({ ignoreAge: true });
    if (reloaded) return reloaded;
  }

  if (state.refreshing) return state.refreshing;

  state.refreshing = refreshWafSession({ force }).finally(() => {
    state.refreshing = null;
  });
  return state.refreshing;
}

export function importWafCookies(input, source = 'api-import') {
  return applyCookies(input, { source, persist: true, refreshedAt: Date.now() });
}

export function getWafCookieHeader() {
  return state.cookieHeader || '';
}

export function getWafSessionInfo() {
  return {
    ready: Boolean(state.cookieHeader),
    mode: AUTO_HARVEST ? 'auto-harvest-optional' : 'external-cookie',
    autoHarvest: AUTO_HARVEST,
    source: state.source || '',
    cookieCount: state.cookies.length,
    cookieNames: state.cookies.map((c) => c.name),
    requiredCookies: REQUIRED_COOKIES,
    cacheFile: CACHE_FILE,
    refreshedAt: state.refreshedAt ? new Date(state.refreshedAt).toISOString() : null,
    ageMs: state.refreshedAt ? Date.now() - state.refreshedAt : null,
    refreshMs: REFRESH_MS,
    lastError: state.lastError || '',
  };
}

export async function withWafCookieHeaders(baseHeaders = {}, { force = false } = {}) {
  const cookie = await ensureWafSession({ force });
  if (!cookie) return { ...baseHeaders };
  return {
    ...baseHeaders,
    cookie,
  };
}

export function isWafHtml(text = '') {
  const sample = String(text || '').slice(0, 800);
  return (
    sample.trimStart().startsWith('<') ||
    /aliyun_waf|waf_aa|waf_bb|security.?check|slide to verify/i.test(sample)
  );
}

// Warm from env/file on import. Never launches Playwright here.
try {
  loadFromEnv() || loadCachedCookies({ ignoreAge: true });
} catch (err) {
  state.lastError = err.message || String(err);
}
