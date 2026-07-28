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
// 强制无头浏览器采集：默认始终启用。
// 仅当显式设置 WAF_AUTO_HARVEST=0 时才关闭（本地调试用）。
const AUTO_HARVEST = !['0', 'false', 'no', 'off'].includes(String(process.env.WAF_AUTO_HARVEST || '').trim().toLowerCase());
const REQUIRED_COOKIES = ['ssxmod_itna', 'tfstk', 'acw_tc'];
const HARVEST_MAX_RETRIES = Number.parseInt(process.env.WAF_HARVEST_RETRIES || '', 10) || 3;
const HARVEST_RETRY_DELAY_MS = Number.parseInt(process.env.WAF_HARVEST_RETRY_DELAY_MS || '', 10) || 5000;
// 远程 harvester 服务地址。设置后优先通过 HTTP 调用侧车容器采集 cookie，
// 主进程不需要装 Playwright/Chromium（轻量镜像）。未设置时回退到本地 spawn 子进程。
const HARVESTER_URL = (process.env.WAF_HARVESTER_URL || '').trim().replace(/\/+$/, '');
const HARVEST_HTTP_TIMEOUT_MS = Number.parseInt(process.env.WAF_HARVEST_HTTP_TIMEOUT_MS || '', 10) || 90000;

mkdirSync(dirname(CACHE_FILE), { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });

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
    .filter((c) => c?.name && c.value != null)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function normalizeCookies(input) {
  if (!input) return [];

  if (typeof input === 'string') {
    const header = input.trim();
    if (!header) return [];
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

function applyCookies(cookies, { refreshedAt = Date.now(), source = 'headless-harvest', persist = true } = {}) {
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

function loadCachedCookies({ ignoreAge = false } = {}) {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    const cookies = normalizeCookies(raw);
    if (!cookies.length || !hasRequiredCookies(cookies)) return null;
    const refreshedAt = raw.refreshedAt || Date.now();
    const age = Date.now() - refreshedAt;
    if (!ignoreAge && REFRESH_MS > 0 && age > REFRESH_MS) return null;
    return applyCookies(cookies, {
      refreshedAt,
      source: raw.source || 'cache',
      persist: false,
    });
  } catch {
    return null;
  }
}

// 优先通过 HTTP 调用远程 harvester 侧车服务采集 cookie。
async function harvestViaHttp() {
  if (!HARVESTER_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARVEST_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${HARVESTER_URL}/harvest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`harvester HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text);
    if (!parsed?.ok || !Array.isArray(parsed.cookies)) {
      throw new Error(`harvester bad payload: ${text.slice(0, 300)}`);
    }
    return parsed.cookies;
  } finally {
    clearTimeout(timer);
  }
}

// 回退：本地 spawn 子进程跑 waf-harvest.mjs（需要主进程装了 playwright）。
function runHarvestChild() {
  return new Promise((resolve, reject) => {
    if (!existsSync(HARVEST_SCRIPT)) {
      reject(new Error('waf-harvest.mjs not found and WAF_HARVESTER_URL not set'));
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

async function runHarvest() {
  // 1. 优先远程 HTTP harvester（侧车容器模式，主镜像无需 Chromium）
  if (HARVESTER_URL) {
    return harvestViaHttp();
  }
  // 2. 回退本地 spawn（需要主进程装 playwright，旧 playwright 镜像兼容）
  return runHarvestChild();
}

async function harvestWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= HARVEST_MAX_RETRIES; attempt++) {
    try {
      const cookies = await runHarvest();
      const source = HARVESTER_URL
        ? `http-harvester(#${attempt})`
        : `playwright-harvest(#${attempt})`;
      return applyCookies(cookies, { source, persist: true });
    } catch (err) {
      lastErr = err;
      console.warn(`WAF harvest attempt ${attempt}/${HARVEST_MAX_RETRIES} failed: ${err.message}`);
      if (attempt < HARVEST_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, HARVEST_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(`WAF harvest failed after ${HARVEST_MAX_RETRIES} attempts: ${lastErr?.message || lastErr}`);
}

async function refreshWafSession({ force = false } = {}) {
  try {
    const cached = loadCachedCookies({ ignoreAge: force });
    if (cached) return cached;
    return await harvestWithRetryAndCheck();
  } catch (err) {
    state.lastError = err.message || String(err);
    console.warn('WAF session refresh failed:', state.lastError);
    throw err;
  }
}

async function harvestWithRetryAndCheck() {
  if (!AUTO_HARVEST) {
    throw new Error(
      'AUTO_HARVEST is disabled (WAF_AUTO_HARVEST=0). Re-enable it or run with the harvester service.'
    );
  }
  // 远程 harvester 模式不需要本地 playwright，跳过本地检查。
  if (HARVESTER_URL) {
    return harvestWithRetry();
  }
  // 本地 spawn 模式需要 playwright 可用。
  try {
    await import('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed locally. Set WAF_HARVESTER_URL to use a remote harvester, or run on the playwright image.'
    );
  }
  return harvestWithRetry();
}

export async function ensureWafSession({ force = false } = {}) {
  if (!force) {
    if (state.cookieHeader && Date.now() - state.refreshedAt < REFRESH_MS) {
      return state.cookieHeader;
    }
    const warmed = loadCachedCookies({ ignoreAge: !AUTO_HARVEST });
    if (warmed) return warmed;
  }

  if (state.refreshing) return state.refreshing;

  state.refreshing = refreshWafSession({ force }).finally(() => {
    state.refreshing = null;
  });
  return state.refreshing;
}

export function getWafCookieHeader() {
  return state.cookieHeader || '';
}

export function getWafSessionInfo() {
  return {
    ready: Boolean(state.cookieHeader),
    mode: HARVESTER_URL ? 'remote-harvester' : (AUTO_HARVEST ? 'headless-browser' : 'disabled'),
    autoHarvest: AUTO_HARVEST,
    harvesterUrl: HARVESTER_URL || '',
    source: state.source || '',
    cookieCount: state.cookies.length,
    cookieNames: state.cookies.map((c) => c.name),
    requiredCookies: REQUIRED_COOKIES,
    cacheFile: CACHE_FILE,
    refreshedAt: state.refreshedAt ? new Date(state.refreshedAt).toISOString() : null,
    ageMs: state.refreshedAt ? Date.now() - state.refreshedAt : null,
    refreshMs: REFRESH_MS,
    lastError: state.lastError || '',
    maxRetries: HARVEST_MAX_RETRIES,
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

try {
  loadCachedCookies({ ignoreAge: true });
} catch (err) {
  state.lastError = err.message || String(err);
}