// Site Maintenance Login - opens a WordPress login page in a new tab of your
// own browser and signs you in with the login the dashboard read from Asana.
//
// Only the dashboard (http://127.0.0.1 / localhost, see externally_connectable)
// can ask it to. The login is held in chrome.storage.session - memory only,
// never written to disk - for that one tab, and dropped once you are in, when
// the tab closes, or after 10 minutes.

const TTL = 10 * 60_000;
const key = tabId => `login:${tabId}`;

async function getJob(tabId) {
  const k = key(tabId);
  const job = (await chrome.storage.session.get(k))[k];
  if (job && job.expires < Date.now()) { await chrome.storage.session.remove(k); return null; }
  return job || null;
}
const setJob = (tabId, job) => chrome.storage.session.set({ [key(tabId)]: job });
const dropJob = tabId => chrome.storage.session.remove(key(tabId));

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (msg?.type === 'ping') { reply({ ok: true, version: chrome.runtime.getManifest().version }); return; }
  if (msg?.type !== 'login') return;
  (async () => {
    let url;
    try { url = new URL(msg.url); } catch { throw new Error('Not a valid address.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) addresses.');
    if (!msg.user || !msg.pass) throw new Error('Username and password are required.');
    const tab = await chrome.tabs.create({ url: url.toString(), active: true });
    await setJob(tab.id, { user: String(msg.user), pass: String(msg.pass), host: url.host, expires: Date.now() + TTL, submits: 0 });
    return { ok: true };
  })().then(reply, e => reply({ ok: false, error: e.message }));
  return true; // reply asynchronously
});

// From the page script below: it submitted, it is in, or it gave up.
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  (async () => {
    const job = await getJob(tabId);
    if (!job) return;
    if (msg.type === 'submitted') { job.submits++; await setJob(tabId, job); }
    if (msg.type === 'done') await dropJob(tabId);
  })();
});

chrome.tabs.onRemoved.addListener(tabId => { dropJob(tabId); });

// Every page load in the tab - the login page, a security check before it, the
// page after submitting - gets the page script, which knows what to do.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const job = await getJob(tabId);
  if (!job) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: signIn, args: [job.user, job.pass, job.submits] });
  } catch {
    // A page the browser does not let extensions touch (e.g. its own error page) - try on the next load.
  }
});

/**
 * Runs inside the page. Fills in the login form and submits it. When a
 * security check comes before the form, it fills the form in once it appears;
 * a captcha on the form is left for you to complete before pressing Log In.
 */
function signIn(user, pass, submits) {
  if (window.__ccSignIn) return; // already working on this page
  window.__ccSignIn = true;

  const toast = (text, tone = 'info') => {
    let el = document.getElementById('cc-signin-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cc-signin-toast';
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;padding:10px 14px;border-radius:8px;font:13px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);color:#fff';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.background = tone === 'bad' ? '#b42323' : tone === 'ok' ? '#157a46' : '#2459d6';
    el.textContent = `Site Maintenance: ${text}`;
    if (tone === 'ok') setTimeout(() => el.remove(), 4000);
  };
  const done = () => chrome.runtime.sendMessage({ type: 'done' }).catch(() => {});
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const pick = sels => { for (const s of sels) { const el = [...document.querySelectorAll(s)].find(visible); if (el) return el; } return null; };

  if (document.querySelector('#wpadminbar, #adminmenu, #wpbody')) { toast('signed in', 'ok'); done(); return; }
  const error = document.querySelector('#login_error, .login-error, .woocommerce-error');
  if (error && submits > 0) { toast(`could not sign in - ${error.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)}`, 'bad'); done(); return; }

  const userSels = ['#user_login', 'input[name="log"]', 'input[autocomplete="username"]', 'form input[type=email]', 'form input[type=text]'];
  const passSels = ['#user_pass', 'input[name="pwd"]', 'input[type=password]'];

  // Set values the way typing does, so scripts watching the fields notice.
  const type = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const captchaWidget = form => (form || document).querySelector('.g-recaptcha, iframe[src*="recaptcha/api2/anchor"], .h-captcha, iframe[src*="hcaptcha"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');

  const submit = (form, passField) => {
    chrome.runtime.sendMessage({ type: 'submitted' }).catch(() => {});
    toast('signing in…');
    const btn = form && (form.querySelector('#wp-submit, [type=submit], button:not([type=button])'));
    if (btn) btn.click();
    else if (form?.requestSubmit) form.requestSubmit();
    else passField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  const attempt = () => {
    const u = pick(userSels);
    const p = pick(passSels);
    if (!u || !p) return false;
    const form = p.closest('form');
    type(u, user);
    type(p, pass);
    const remember = document.querySelector('#rememberme');
    if (remember && !remember.checked) remember.click();

    // Don't keep re-submitting the same wrong password.
    if (submits >= 2) { toast('filled in - check the details and press Log In', 'bad'); done(); return true; }

    // A captcha or security question on the form is yours to answer: stop after
    // filling in the login and let you complete it and press Log In.
    const textCaptcha = form && [...form.querySelectorAll('input')].find(i => visible(i) && /captcha|security|answer/i.test(`${i.name} ${i.id} ${i.placeholder}`) && i !== u && i !== p);
    if (captchaWidget(form) || textCaptcha) {
      (textCaptcha || p).focus();
      toast('filled in - complete the captcha and press Log In');
      done();
      return true;
    }
    submit(form, p);
    return true;
  };

  if (attempt()) return;

  // No login form yet: a security check / captcha comes first, or the form is
  // drawn by a script. Watch for the fields; a full page load re-runs this.
  toast('waiting for the login form - complete the security check if there is one');
  const obs = new MutationObserver(() => { if (attempt()) obs.disconnect(); });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  setTimeout(() => obs.disconnect(), 10 * 60_000);
}

// Clicking the toolbar icon opens the dashboard. It runs on 127.0.0.1; the port
// is usually 4590 - try that, then a couple of common alternates, and focus an
// already-open tab instead of opening another.
const DASHBOARD_PORTS = [4590, 4591, 4599];
chrome.action.onClicked.addListener(async () => {
  let url = null;
  for (const port of DASHBOARD_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { url = `http://127.0.0.1:${port}/`; break; }
    } catch {}
  }
  if (url) {
    // Dashboard is running - focus its tab, or open one.
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const open = tabs.find(t => t.url && t.url.startsWith(url));
    if (open) chrome.tabs.update(open.id, { active: true });
    else chrome.tabs.create({ url });
    return;
  }
  // Not running - ask the Site Maintenance app (macOS) to start it. The browser
  // shows a one-time "Open Site Maintenance?" prompt; the app starts the server
  // and the dashboard opens itself. On Windows, start it with `npm start`.
  const dash = `http://127.0.0.1:${DASHBOARD_PORTS[0]}/`;
  try { await chrome.tabs.create({ url: 'claude-connector://open' }); } catch {}
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(`${dash}api/state`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { chrome.tabs.create({ url: dash }); return; } } catch {}
  }
  chrome.tabs.create({ url: dash }); // give up waiting; open anyway
});
