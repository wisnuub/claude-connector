// "Log in": opens a site's login page in a visible browser window, fills in the
// username and password and submits - for any WordPress site, with or without
// the connector. The window has its own profile (data/browser-profile), so it
// never touches your everyday browser and stays signed in between uses.
//
// When the site asks for something only a person can give - a captcha, a
// security check before the form, a two-factor code - it leaves that to you.
import path from 'path';
import { DATA_DIR } from './store.js';
import { importPlaywright } from './deps.js';

const PROFILE = path.join(DATA_DIR, 'browser-profile');
let ctxPromise = null;

async function context() {
  const existing = await ctxPromise?.catch(() => null);
  if (existing && existing.browser()?.isConnected?.() !== false && existing.pages) {
    try { await existing.pages(); return existing; } catch {}
  }
  ctxPromise = (async () => {
    const { chromium } = await importPlaywright('Log in');
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

const USER_SEL = ['#user_login', 'input[name="log"]', 'input[autocomplete="username"]', 'form:has(input[type=password]) input[type=email]', 'form:has(input[type=password]) input[type=text]'];
const PASS_SEL = ['#user_pass', 'input[name="pwd"]', 'input[type=password]'];
const CAPTCHA_SEL = '.g-recaptcha, iframe[src*="recaptcha/api2/anchor"], .h-captcha, iframe[src*="hcaptcha"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]';

async function first(page, sels) {
  for (const s of sels) {
    const l = page.locator(s).first();
    if (await l.isVisible().catch(() => false)) return l;
  }
  return null;
}

/** A captcha widget or security question on the page - always left to the person. */
const hasCaptcha = page => page.evaluate(sel => !!document.querySelector(sel)
  || [...document.querySelectorAll('form input')].some(i => /captcha|security|answer/i.test(`${i.name} ${i.id} ${i.placeholder}`)), CAPTCHA_SEL).catch(() => false);

async function fillAndSubmit(page, uField, pField, user, pass) {
  await uField.fill(user);
  await pField.fill(pass);
  const remember = page.locator('#rememberme');
  if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => {});
  const submit = await first(page, ['#wp-submit', 'form:has(input[type=password]) [type=submit]', 'form:has(input[type=password]) button']);
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }).catch(() => {}),
    submit ? submit.click() : pField.press('Enter'),
  ]);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * When a security check comes before the login form: keep watching the window
 * while the person completes it and fill the form in when it appears. Submits
 * only when the form itself has no captcha; otherwise that last step is theirs.
 */
async function fillWhenReady(page, user, pass) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && !page.isClosed()) {
    if (await page.evaluate(inAdmin).catch(() => false)) return;
    const u = await first(page, USER_SEL);
    const p = await first(page, PASS_SEL);
    if (u && p) {
      if (await hasCaptcha(page)) { await u.fill(user).catch(() => {}); await p.fill(pass).catch(() => {}); return; }
      await fillAndSubmit(page, u, p, user, pass).catch(() => {});
      return;
    }
    await page.waitForTimeout(800).catch(() => {});
  }
}

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

  let uField = await first(page, USER_SEL);
  let pField = await first(page, PASS_SEL);
  if ((!uField || !pField) && /\/wp-admin\/$/.test(target)) {
    // Security plugins that hide the login page also hide /wp-admin/ when signed out.
    await page.goto(target.replace(/wp-admin\/$/, 'wp-login.php'), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    uField = await first(page, USER_SEL);
    pField = await first(page, PASS_SEL);
  }

  // A security check before the form: hand over, fill the form in when it appears.
  if (!uField || !pField) {
    fillWhenReady(page, user, pass).catch(() => {});
    return { status: 'needs_you', message: 'Complete the security check in the window - the login is filled in when the form appears.', url: page.url() };
  }
  // A captcha on the form: fill in the login and leave the captcha and Log In to the person.
  if (await hasCaptcha(page)) {
    await uField.fill(user);
    await pField.fill(pass);
    return { status: 'needs_you', message: 'Filled in - complete the captcha in the window and press Log In.', url: page.url() };
  }

  await fillAndSubmit(page, uField, pField, user, pass);
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
