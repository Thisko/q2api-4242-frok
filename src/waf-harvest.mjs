import { chromium } from 'playwright';
import os from 'os';

const profileDir = process.argv[2];
const warmupMs = Number.parseInt(process.argv[3] || '5000', 10) || 5000;
const required = ['ssxmod_itna', 'tfstk', 'acw_tc'];

function hasRequired(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return required.every((n) => names.has(n));
}

const launchOptions = {
  headless: true,
  viewport: { width: 1365, height: 900 },
  locale: 'zh-CN',
  timezoneId: process.env.TZ || 'Asia/Shanghai',
  userAgent:
    process.env.WAF_USER_AGENT ||
    (os.platform() === 'win32'
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'),
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

// Explicit overrides first.
if (process.env.WAF_BROWSER_EXECUTABLE) {
  launchOptions.executablePath = process.env.WAF_BROWSER_EXECUTABLE;
} else if (process.env.WAF_BROWSER_CHANNEL) {
  launchOptions.channel = process.env.WAF_BROWSER_CHANNEL;
} else if (os.platform() === 'win32' || os.platform() === 'darwin') {
  // Local desktop: prefer installed Chrome. Docker/OpenWrt leaves this unset
  // so Playwright uses the bundled Chromium installed in the image.
  launchOptions.channel = 'chrome';
}

const context = await chromium.launchPersistentContext(profileDir, launchOptions);

try {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(warmupMs);

  let cookies = await context.cookies();
  for (let i = 0; i < 8 && !hasRequired(cookies); i++) {
    await page.waitForTimeout(1000);
    cookies = await context.cookies();
  }

  if (!hasRequired(cookies)) {
    console.error(JSON.stringify({ ok: false, error: 'incomplete cookies', names: cookies.map((c) => c.name) }));
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({ ok: true, cookies }) + '\n');
  process.exit(0);
} catch (err) {
  console.error(String(err && err.stack || err));
  process.exit(1);
} finally {
  await context.close().catch(() => {});
}
