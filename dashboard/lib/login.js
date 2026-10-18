// "Log in": opens a site's login page in a visible browser window, fills in the
// username and password and submits - for any WordPress site, with or without
// the connector. The window has its own profile (data/browser-profile), so it
// never touches your everyday browser and stays signed in between uses.
//
// It stops and leaves the window to you when the site asks for something only
// a person can give: a captcha or a two-factor code.
import path from 'path';
import { DATA_DIR } from './store.js';

const PROFILE = path.join(DATA_DIR, 'browser-profile');
let ctxPromise = null;

async function context() {
  const existing = await ctxPromise?.catch(() => null);
  if (existing && existing.browser()?.isConnected?.() !== false && existing.pages) {
    try { await existing.pages(); return existing; } catch {}
  }
  ctxPromise = (async () => {
    let chromium;
    try { ({ chromium } = await import('playwright-core')); }
    catch { throw new Error('Log in needs playwright-core. In the dashboard folder run: npm install'); }
    // CC_LOGIN_HEADLESS is for automated checks; people get a window they can use.
    const opts = { headless: !!process.env.CC_LOGIN_HEADLESS, viewport: null, args: ['--start-maximized'] };
    for (const channel of ['chrome', 'msedge']) {
      try { return await chromium.launchPersistentContext(PROFILE, { ...opts, channel }); } catch {}
    }
    if (process.env.CHROME_PATH) return chromium.launchPersistentContext(PROFILE, { ...opts, executablePath: process.env.CHROME_PATH });
    throw new Error('No browser found for Log in. Install Google Chrome or Microsoft Edge, or set CHROME_PATH.');
  })();
  const ctx = await ctxPromise;
  ctx.on('close', () => { ctxPromise = null; });
  return ctx;
}

/**
 * The page to log in on. A login/admin address (wp-login.php, wp-admin, or a
 * custom slug such as /hidden-login) is used as written; anything else is taken
 * as the site's address - including a subfolder install like /newsite - and
 * gets /wp-admin/, which goes straight in when already signed in and to the
 * login form (and back) when not.
 */
export function loginUrlFor(url) {
  const u = new URL(url);
  if (/wp-login\.php|wp-admin|login|admin/i.test(u.pathname)) return u.toString();
  u.pathname = u.pathname.replace(/\/?$/, '/') + 'wp-admin/';
  u.search = '';
  return u.toString();
}

const inAdmin = () => !!document.querySelector('#wpadminbar, #adminmenu, #wpbody');

/**
 * @param {object} o  { url, user, pass }
 * @returns {Promise<object>} { status: logged_in | needs_you | failed, message, url }
 */
export async function logIn({ url, user, pass }) {
  if (!url || !user || !pass) throw new Error('A login needs the site address, username and password.');
  const ctx = await context();
  const page = await ctx.newPage();
  await page.bringToFront();
  const target = loginUrlFor(url);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

  // Still signed in from last time.
  if (await page.evaluate(inAdmin).catch(() => false)) return { status: 'logged_in', message: 'Already signed in.', url: page.url() };

  // WordPress's own form first, then any form with a password field.
  const userSel = ['#user_login', 'input[name="log"]', 'input[autocomplete="username"]', 'form:has(input[type=password]) input[type=email]', 'form:has(input[type=password]) input[type=text]'];
  const passSel = ['#user_pass', 'input[name="pwd"]', 'input[type=password]'];
  const first = async sels => { for (const s of sels) { const l = page.locator(s).first(); if (await l.isVisible().catch(() => false)) return l; } return null; };
  let uField = await first(userSel);
  let pField = await first(passSel);
  if ((!uField || !pField) && /\/wp-admin\/$/.test(target)) {
    // Security plugins that hide the login page also hide /wp-admin/ when signed out.
    await page.goto(target.replace(/wp-admin\/$/, 'wp-login.php'), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    uField = await first(userSel);
    pField = await first(passSel);
  }
  if (!uField || !pField) {
    return { status: 'needs_you', message: `No login form at ${target} - the site may use a custom login address. The window is open for you.`, url: page.url() };
  }
  await uField.fill(user);
  await pField.fill(pass);
  const remember = page.locator('#rememberme');
  if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => {});

  const captcha = await page.locator('.g-recaptcha, iframe[src*="recaptcha"], .h-captcha, iframe[src*="hcaptcha"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name*="captcha" i]').first().isVisible().catch(() => false);
  if (captcha) return { status: 'needs_you', message: 'Filled in - the site has a captcha, solve it and press Log In in the window.', url: page.url() };

  const submit = await first(['#wp-submit', 'form:has(input[type=password]) [type=submit]', 'form:has(input[type=password]) button']);
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }).catch(() => {}),
    submit ? submit.click() : pField.press('Enter'),
  ]);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  if (await page.evaluate(inAdmin).catch(() => false)) return { status: 'logged_in', message: 'Signed in.', url: page.url() };
  const error = (await page.locator('#login_error, .login-error, .woocommerce-error').first().textContent().catch(() => '') || '').trim().replace(/\s+/g, ' ');
  if (error) return { status: 'failed', message: error.slice(0, 300), url: page.url() };
  const body = (await page.locator('body').textContent().catch(() => '')).toLowerCase();
  if (/authentication code|verification code|two-factor|2fa|one-time|security code|authenticator/.test(body)) {
    return { status: 'needs_you', message: 'The site asks for a two-factor code - enter it in the window.', url: page.url() };
  }
  return { status: 'needs_you', message: 'Submitted, but it did not reach the dashboard - check the window.', url: page.url() };
}

export async function closeLoginBrowser() {
  const c = await ctxPromise?.catch(() => null);
  ctxPromise = null;
  if (c) await c.close().catch(() => {});
}
