// Real-browser screenshots for wp_page_screenshot.
//
// Database state can't show a page that rendered on the wrong template, a font
// that lost a specificity fight, an image that never loaded or an overlay at half
// opacity - only looking at the page can. This drives a local browser so Claude
// can look at what it built, including password-protected preview pages.
//
// playwright-core downloads no browsers. It uses, in order: CHROME_PATH, a
// Playwright-managed Chromium if one is installed, then the system's Chrome or
// Edge (Edge ships with every Windows install).
import fs from 'fs';
import os from 'os';
import path from 'path';

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile:  { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

function playwrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort(); } catch { continue; }
    for (const d of dirs.reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

async function launch() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new Error('wp_page_screenshot needs the playwright-core package. In the MCP server folder run: npm install'); }

  const exe = process.env.CHROME_PATH || playwrightChromium();
  if (exe) return chromium.launch({ executablePath: exe });
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel }); } catch {}
  }
  throw new Error('No browser found for screenshots. Install Google Chrome or Microsoft Edge, or set CHROME_PATH.');
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} [o.password]   WordPress post password, for protected preview pages
 * @param {'desktop'|'mobile'} [o.device]
 * @param {boolean} [o.fullPage]  capture the whole page as consecutive slices
 * @param {number} [o.maxSlices]
 * @param {string} [o.scrollTo]   CSS selector: capture the viewport at this element
 * @param {number} [o.waitMs]
 */
export async function screenshot({ url, password, device = 'desktop', fullPage = false, maxSlices = 4, scrollTo, waitMs = 1500, allowVideo = false }) {
  const browser = await launch();
  try {
    const ctx = await browser.newContext(VIEWPORTS[device] || VIEWPORTS.desktop);
    // Don't download video by default. A hero background video is often 20MB+,
    // and repeated screenshot runs against a client's shared host can trip its
    // per-IP bandwidth throttling (LiteSpeed/CloudLinux) - after which the site
    // looks slow from your machine while real visitors are unaffected. Video
    // backgrounds then show their fallback image/colour in the capture.
    if (!allowVideo) {
      await ctx.route('**/*', route => (route.request().resourceType() === 'media' ? route.abort() : route.continue()));
    }
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});

    if (password) {
      const field = page.locator('input[name="post_password"]');
      if (await field.count()) {
        await field.fill(password);
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}), field.press('Enter')]);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      }
    }
    const stillLocked = await page.locator('input[name="post_password"]').count();

    // Scroll the real document height so lazy images and scroll-triggered
    // reveals fire, then wait for every image to decode.
    await page.evaluate(async () => {
      const H = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y < H(); y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
      document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && [...document.images].some(i => !i.complete)) await new Promise(r => setTimeout(r, 250));
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(waitMs);

    const info = await page.evaluate(() => ({
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      title: document.title,
      brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('src'))
        .map(i => i.getAttribute('src').split('/').pop()).slice(0, 20),
    }));

    const { width, height: vh } = (VIEWPORTS[device] || VIEWPORTS.desktop).viewport;
    const images = [];
    if (scrollTo) {
      await page.locator(scrollTo).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      images.push(await page.screenshot({ type: 'jpeg', quality: 72 }));
    } else if (fullPage) {
      // Slices of two viewports each, so text stays legible. Note: elements with
      // position:sticky appear pinned at their first position in these slices.
      const slice = vh * 2;
      const limit = Math.min(Math.max(1, maxSlices), 8);
      for (let y = 0, i = 0; y < info.height && i < limit; y += slice, i++) {
        images.push(await page.screenshot({ type: 'jpeg', quality: 72, fullPage: true,
          clip: { x: 0, y, width, height: Math.min(slice, info.height - y) } }));
      }
    } else {
      images.push(await page.screenshot({ type: 'jpeg', quality: 72 }));
    }
    return { ...info, url, device, locked: stillLocked > 0, images: images.map(b => b.toString('base64')) };
  } finally {
    await browser.close();
  }
}
