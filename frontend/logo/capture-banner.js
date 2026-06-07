const puppeteer = require('puppeteer');
const path      = require('path');

(async () => {
  const bannerFile = 'file:///' +
    path.resolve(__dirname, 'youtube-banner.html').replace(/\\/g, '/');

  console.log('Launching browser…');
  const browser = await puppeteer.launch({ headless: 'new' });
  const page    = await browser.newPage();

  // Match banner canvas exactly
  await page.setViewport({ width: 2560, height: 1440, deviceScaleFactor: 1 });
  await page.goto(bannerFile, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for Google Fonts to render
  await new Promise(r => setTimeout(r, 2000));

  // Hide the export UI so it doesn't appear in the screenshot
  await page.evaluate(() => {
    const ui = document.getElementById('exportUI');
    if (ui) ui.style.display = 'none';
  });

  // ── Full banner (2560×1440) ──────────────────────────────────────────────
  const fullPath = path.join(__dirname, 'hordex-banner-full.png');
  await page.screenshot({
    path:    fullPath,
    clip:    { x: 0, y: 0, width: 2560, height: 1440 },
    type:    'png'
  });
  console.log('✓ Saved:', fullPath);

  // ── Safe zone only (1546×423, centred at x=507 y=508) ───────────────────
  const safePath = path.join(__dirname, 'hordex-banner-safe.png');
  await page.screenshot({
    path:    safePath,
    clip:    { x: 507, y: 508, width: 1546, height: 423 },
    type:    'png'
  });
  console.log('✓ Saved:', safePath);

  await browser.close();
  console.log('Done!');
})();
