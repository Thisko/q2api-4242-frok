// WAF harvester 服务：独立的无头浏览器 cookie 采集器
// GET /harvest        -> 立即采集一次，返回 {ok, cookies}
// GET /healthz        -> 存活检查
// GET /readyz         -> Playwright + Chromium 可用性检查
import express from 'express';
import { chromium } from 'playwright';
import os from 'os';

const app = express();
app.use(express.json());

const PORT = Number.parseInt(process.env.PORT || '3100', 10);
const PROFILE_DIR = process.env.WAF_PROFILE_DIR || '/data/chrome-profile-waf';
const WARMUP_MS = Number.parseInt(process.env.WAF_COOKIE_WARMUP_MS || '', 10) || 5000;
const REQUIRED = ['ssxmod_itna', 'tfstk', 'acw_tc'];

function hasRequired(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return REQUIRED.every((n) => names.has(n));
}

function launchOptions() {
  const opts = {
    headless: true,
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN',
    timezoneId: process.env.TZ || 'Asia/Shanghai',
    userAgent:
      process.env.WAF_USER_AGENT ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (process.env.WAF_BROWSER_EXECUTABLE) {
    opts.executablePath = process.env.WAF_BROWSER_EXECUTABLE;
  } else if (process.env.WAF_BROWSER_CHANNEL) {
    opts.channel = process.env.WAF_BROWSER_CHANNEL;
  }
  return opts;
}

async function harvest() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions());
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(WARMUP_MS);

    let cookies = await context.cookies();
    for (let i = 0; i < 8 && !hasRequired(cookies); i++) {
      await page.waitForTimeout(1000);
      cookies = await context.cookies();
    }
    if (!hasRequired(cookies)) {
      throw new Error(`incomplete cookies: ${cookies.map((c) => c.name).join(',')}`);
    }
    return cookies;
  } finally {
    await context.close().catch(() => {});
  }
}

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/readyz', async (req, res) => {
  try {
    await import('playwright');
    // 不真正启动浏览器，只检查模块可用
    res.json({ ready: true, playwright: true });
  } catch (e) {
    res.status(503).json({ ready: false, error: e.message });
  }
});

app.get('/harvest', async (req, res) => {
  const started = Date.now();
  try {
    const cookies = await harvest();
    res.json({
      ok: true,
      cookies,
      durationMs: Date.now() - started,
      count: cookies.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || String(err),
      durationMs: Date.now() - started,
    });
  }
});

app.listen(PORT, () => {
  console.log(`waf-harvester listening on :${PORT}`);
  console.log(`  GET /harvest  - run one headless harvest`);
  console.log(`  GET /healthz  - liveness`);
  console.log(`  GET /readyz   - playwright availability`);
});