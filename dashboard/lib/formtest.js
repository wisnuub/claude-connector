// Submits a site's real contact form in a real browser, the way a visitor
// would: fill every visible field by what it asks for, solve Divi's built-in
// math captcha, press submit, then read the form plugin's own success or
// error message. That tests the whole chain - the form, its validation, spam
// protection and the plugin's mail step - not just wp_mail().
//
// playwright-core downloads no browsers: it uses CHROME_PATH, a
// Playwright-managed Chromium, then the system's Chrome or Edge.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SCREENS_DIR } from './store.js';

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

let browserPromise = null;

async function browser(headless) {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected() && b.__headless === headless) return b;
    if (b) await b.close().catch(() => {});
  }
  browserPromise = (async () => {
    let chromium;
    try { ({ chromium } = await import('playwright-core')); }
    catch { throw new Error('The form test needs playwright-core. In the dashboard folder run: npm install'); }
    const exe = process.env.CHROME_PATH || playwrightChromium();
    let b = null;
    if (exe) b = await chromium.launch({ executablePath: exe, headless });
    for (const channel of ['chrome', 'msedge']) {
      if (b) break;
      try { b = await chromium.launch({ channel, headless }); } catch {}
    }
    if (!b) throw new Error('No browser found for the form test. Install Google Chrome or Microsoft Edge, or set CHROME_PATH.');
    b.__headless = headless;
    return b;
  })();
  return browserPromise;
}

export async function closeBrowser() {
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

// Ordered: the first that matches a visible form on the page is the one tested.
const FORM_KINDS = [
  { kind: 'divi', sel: '.et_pb_contact_form_container form.et_pb_contact_form' },
  { kind: 'contact-form-7', sel: '.wpcf7 form.wpcf7-form' },
  { kind: 'gravity-forms', sel: '.gform_wrapper form' },
  { kind: 'wpforms', sel: 'form.wpforms-form' },
  { kind: 'elementor-pro', sel: 'form.elementor-form' },
  { kind: 'fluent-forms', sel: 'form.frm-fluent-form' },
  { kind: 'forminator', sel: 'form.forminator-custom-form' },
];

const CAPTCHA_SEL = '.g-recaptcha, iframe[src*="recaptcha/api2/anchor"], .h-captcha, iframe[src*="hcaptcha.com"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]';

/**
 * Runs in the page. Tags the target form and its fields, decides a value for
 * each, and returns the plan. Kept self-contained: it is serialised into the page.
 */
function planInPage({ kinds, contact, ref }) {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  // Checkboxes, radios and selects are often visually replaced by styled
  // stand-ins (Forminator, Gravity, select2); judge them by their label/wrapper.
  const visibleChoice = el => visible(el) || (el.labels && [...el.labels].some(visible)) || (el.closest('label') && visible(el.closest('label')))
    || (el.parentElement && visible(el.parentElement));
  // Options a person would actually choose: not the "Please select" placeholder.
  const realOptions = sel => [...sel.options].filter(o => o.value && !o.disabled && !/^(select|choose|please|-|—)/i.test(o.text.trim()));
  const pick = (list, random) => list.length ? list[random ? Math.floor(Math.random() * list.length) : 0] : null;
  const randomChoices = contact.choices === 'random';
  const rules = (contact.rules || []).filter(r => r && r.match).map(r => ({ match: String(r.match).toLowerCase().trim(), value: String(r.value ?? '') }));

  let form = null, kind = 'generic';
  for (const k of kinds) {
    form = [...document.querySelectorAll(k.sel)].find(visible);
    if (form) { kind = k.kind; break; }
  }
  if (!form) {
    // Any form that looks like a contact form: has a textarea or email field and is not search/login/comments.
    form = [...document.querySelectorAll('form')].find(f => visible(f)
      && f.querySelector('textarea, input[type=email]')
      && !f.matches('[role=search], .search-form, #commentform, #loginform, .woocommerce-cart-form, .comment-form')
      && !f.querySelector('input[name=s], input[name=log], #comment'));
  }
  if (!form) return { found: false };
  form.setAttribute('data-cc-form', '1');

  const [first, ...rest] = (contact.name || 'Website Maintenance').split(' ');
  const last = rest.join(' ') || 'Test';
  const message = (contact.message || '').replace(/\{ref\}/g, ref);
  const today = new Date().toISOString().slice(0, 10);

  const labelOf = el => {
    const bits = [];
    if (el.labels) for (const l of el.labels) bits.push(l.innerText);
    const wrap = el.closest('.et_pb_contact_field, .wpcf7-form-control-wrap, .gfield, .wpforms-field, .elementor-field-group, .ff-el-group, .forminator-field, p, label');
    if (wrap) { const l = wrap.querySelector('label, legend, .gfield_label'); if (l) bits.push(l.innerText); }
    bits.push(el.getAttribute('aria-label') || '', el.placeholder || '', el.name || '', el.id || '', el.getAttribute('data-original_id') || '');
    return bits.join(' ').toLowerCase().replace(/\s+/g, ' ');
  };
  // What a person would call the field, for the results table.
  const displayLabel = el => {
    const wrap = el.closest('.et_pb_contact_field, .wpcf7-form-control-wrap, .gfield, .wpforms-field, .elementor-field-group, .ff-el-group, .forminator-field');
    const cands = [
      el.labels && el.labels[0]?.innerText,
      wrap?.querySelector('label, legend, .gfield_label, .et_pb_contact_field_options_title')?.innerText,
      el.closest('label')?.innerText,
      el.getAttribute('aria-label'), el.placeholder, el.name,
    ];
    const t = cands.map(x => (x || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim()).find(Boolean) || 'field';
    return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  };
  const isRequired = el => el.required || el.getAttribute('aria-required') === 'true'
    || el.getAttribute('data-required_mark') === 'required'
    || !!el.closest('.gfield_contains_required, .wpforms-field-required, .elementor-field-required, .is-required, .wpcf7-validates-as-required')
    || !!el.closest('.et_pb_contact_field')?.querySelector('[data-required_mark="required"]');

  const fields = [];
  const doneGroups = new Set();
  let i = 0;
  let captcha = null;
  for (const el of form.querySelectorAll('input, textarea, select')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || el.disabled || el.readOnly) continue;
    const choice = type === 'checkbox' || type === 'radio' || el.tagName === 'SELECT';
    if (choice ? !visibleChoice(el) : !visible(el)) continue; // honeypots are hidden
    const label = labelOf(el);
    const id = `f${i++}`;
    el.setAttribute('data-cc-field', id);
    const req = isRequired(el);
    const short = displayLabel(el);

    if (el.classList.contains('et_pb_contact_captcha')) {
      // Divi's own spam check: "first + second =" with both digits in data attributes.
      const sum = Number(el.dataset.first_digit) + Number(el.dataset.second_digit);
      fields.push({ id, action: 'fill', value: String(sum), label: 'Divi captcha', shown: `${el.dataset.first_digit} + ${el.dataset.second_digit}` });
      continue;
    }
    const math = /(\d+)\s*([+\-x×*])\s*(\d+)\s*(=|\?)/.exec(label);
    if (math && type !== 'email' && el.tagName !== 'TEXTAREA') {
      const a = Number(math[1]), b = Number(math[3]);
      const v = math[2] === '+' ? a + b : math[2] === '-' ? a - b : a * b;
      fields.push({ id, action: 'fill', value: String(v), label: `Math captcha ${math[0]}` });
      continue;
    }
    // The agency's own rules come first: "label contains X" -> Y.
    // Special values: {random} / {first} pick an option, {skip} leaves the field alone.
    const rule = rules.find(r => label.includes(r.match));
    if (rule) {
      const radioOrCheck = type === 'checkbox' || type === 'radio';
      const want = rule.value.trim().toLowerCase();
      if (want === '{skip}') { fields.push({ id, action: 'skip', label: short, rule: rule.match, note: 'skipped by rule' }); if (radioOrCheck) doneGroups.add(el.name || id); continue; }
      if (el.tagName === 'SELECT') {
        const opt = want === '{random}' ? pick(realOptions(el), true) : want === '{first}' ? pick(realOptions(el), false)
          : [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
            || [...el.options].find(o => o.value && o.text.toLowerCase().includes(want));
        if (opt) { fields.push({ id, action: 'select', value: opt.value, label: short, rule: rule.match, shown: opt.text.trim() }); continue; }
      } else if (radioOrCheck) {
        const group = el.name || id;
        if (doneGroups.has(group)) continue;
        if (want === '{random}' || want === '{first}') {
          // Choose among the whole group, not just this first box.
          const members = el.name ? [...form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)].filter(visibleChoice) : [el];
          const chosen = pick(members, want === '{random}') || el;
          if (chosen !== el) { chosen.setAttribute('data-cc-field', `${id}r`); }
          doneGroups.add(group);
          fields.push({ id: chosen === el ? id : `${id}r`, action: 'check', label: short, rule: rule.match, shown: ((chosen.labels && chosen.labels[0]?.innerText) || chosen.value || '').trim() });
          continue;
        }
        // The option whose own label matches the value; "yes"/empty ticks a single box.
        const own = ((el.labels && el.labels[0]?.innerText) || el.value || '').toLowerCase();
        if (!want || ['yes', 'true', 'tick', 'check', '1'].includes(want) || own.includes(want)) {
          doneGroups.add(group);
          fields.push({ id, action: 'check', label: short, rule: rule.match });
        }
        continue;
      } else {
        fields.push({ id, action: 'fill', value: rule.value.replace(/\{ref\}/g, ref).replace(/\{random\}/gi, () => Math.random().toString(36).slice(2, 8)), label: short, rule: rule.match });
        continue;
      }
    }
    if (type === 'file') { if (req) fields.push({ id, action: 'skip', label: short, note: 'Required file upload - cannot be filled' }); continue; }

    if (type === 'checkbox' || type === 'radio') {
      const group = el.name || id;
      if (doneGroups.has(group)) continue;
      const consent = /consent|agree|accept|privacy|terms|gdpr|acknowledge|subscribe/.test(label) && !/newsletter|marketing|subscribe/.test(label);
      if (type === 'radio' || req || consent || el.closest('.wpcf7-acceptance')) {
        doneGroups.add(group);
        // A radio group gets one choice - random when the agency says so; consent boxes always this one.
        let chosen = el;
        if (type === 'radio' && randomChoices && el.name) {
          chosen = pick([...form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)].filter(visibleChoice), true) || el;
          if (chosen !== el) chosen.setAttribute('data-cc-field', `${id}r`);
        }
        fields.push({ id: chosen === el ? id : `${id}r`, action: 'check', label: short, ...(type === 'radio' ? { shown: ((chosen.labels && chosen.labels[0]?.innerText) || chosen.value || '').trim() } : {}) });
      }
      continue;
    }
    if (el.tagName === 'SELECT') {
      const opt = pick(realOptions(el), randomChoices);
      if (opt) fields.push({ id, action: 'select', value: opt.value, label: short, shown: opt.text.trim() });
      continue;
    }

    let value;
    if (el.tagName === 'TEXTAREA') value = message;
    else if (type === 'email' || /e-?mail/.test(label)) value = contact.email;
    else if (type === 'tel' || /phone|mobile|tel\b|contact number/.test(label)) value = contact.phone;
    else if (type === 'url' || /website|url\b/.test(label)) value = 'https://example.com';
    else if (type === 'number' || type === 'range') value = el.min || '1';
    else if (type === 'date') value = today;
    else if (type === 'time') value = '10:00';
    else if (/first|given|fname/.test(label)) value = first;
    else if (/last|surname|family|lname/.test(label)) value = last;
    else if (/subject|topic|regarding/.test(label)) value = (contact.subject || 'Website maintenance test {ref}').replace(/\{ref\}/g, ref);
    else if (/company|business|organi[sz]ation/.test(label)) value = contact.company || 'Maintenance Test';
    else if (/post ?code|zip/.test(label)) value = '3000';
    else if (/city|suburb|town/.test(label)) value = 'Melbourne';
    else if (/address|street/.test(label)) value = '1 Test Street';
    else if (/name/.test(label)) value = contact.name;
    else if (/message|enquiry|inquiry|comment|question|details|how can we help/.test(label)) value = message;
    else value = `Maintenance test ${ref}`;
    fields.push({ id, action: 'fill', value, label: short });
  }

  const box = form.closest('.et_pb_contact_form_container, .wpcf7, .gform_wrapper, .wpforms-container, .elementor-widget-form, .fluentform, .forminator-ui') || form.parentElement;
  const capEl = box.querySelector(CAPTCHA_SEL_IN_PAGE) || form.querySelector(CAPTCHA_SEL_IN_PAGE);
  if (capEl) captcha = capEl.className.includes('turnstile') || (capEl.src || '').includes('cloudflare') ? 'Cloudflare Turnstile'
    : capEl.className.includes('h-captcha') || (capEl.src || '').includes('hcaptcha') ? 'hCaptcha' : 'reCAPTCHA v2';
  // Invisible reCAPTCHA v3 (CF7's default) scores a headless browser low and may flag the test as spam.
  const recaptchaV3 = !!document.querySelector('script[src*="recaptcha/api.js?render="], script[src*="recaptcha/api.js?render%3D"]');

  const submit = form.querySelector('button[type=submit], input[type=submit], button.et_pb_contact_submit, button:not([type])');
  if (submit) submit.setAttribute('data-cc-submit', '1');
  if (box) box.setAttribute('data-cc-box', '1');
  return { found: true, kind, fields, captcha, recaptchaV3, hasSubmit: !!submit };
}

/** Runs in the page: has the form reported success or failure yet? */
function outcomeInPage(kind) {
  const box = document.querySelector('[data-cc-box]') || document.body;
  const text = el => (el ? el.innerText.trim().replace(/\s+/g, ' ') : '');
  const visible = el => el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
  const form = document.querySelector('[data-cc-form]');

  if (kind === 'divi') {
    const msg = box.querySelector('.et-pb-contact-message');
    const errFields = box.querySelectorAll('.et_contact_error');
    if (errFields.length || msg?.querySelector('ul, li')) return { done: true, ok: false, message: text(msg) || `${errFields.length} field(s) flagged` };
    if (msg && text(msg) && (!form || !visible(form))) return { done: true, ok: true, message: text(msg) };
    if (msg && text(msg)) return { done: true, ok: false, message: text(msg) };
    return { done: false };
  }
  if (kind === 'contact-form-7') {
    const f = box.querySelector('form.wpcf7-form');
    const status = f?.getAttribute('data-status') || '';
    const out = text(box.querySelector('.wpcf7-response-output'));
    if (status === 'sent' || f?.classList.contains('sent')) return { done: true, ok: true, message: out };
    if (['invalid', 'failed', 'spam', 'aborted'].includes(status) || /\b(invalid|failed|spam|aborted)\b/.test(f?.className || '')) {
      const tips = [...box.querySelectorAll('.wpcf7-not-valid-tip')].map(text).join('; ');
      return { done: true, ok: false, message: `${out}${tips ? ` (${tips})` : ''} [${status || 'failed'}]` };
    }
    return { done: false };
  }
  const pairs = {
    'gravity-forms': ['.gform_confirmation_message, .gform_confirmation_wrapper', '.gform_validation_errors, .validation_error, .gfield_error .validation_message'],
    'wpforms': ['.wpforms-confirmation-container, .wpforms-confirmation-container-full', '.wpforms-error-container, label.wpforms-error, em.wpforms-error'],
    'elementor-pro': ['.elementor-message-success', '.elementor-message-danger, .elementor-error .elementor-message, .elementor-field-group .elementor-message-danger'],
    'fluent-forms': ['.ff-message-success', '.ff-errors-in-stack, .ff-el-is-error .error, .text-danger'],
    'forminator': ['.forminator-response-message.forminator-success, .forminator-success', '.forminator-response-message.forminator-error, .forminator-error-message'],
  };
  const doc = document;
  if (pairs[kind]) {
    const ok = [...doc.querySelectorAll(pairs[kind][0])].find(visible);
    if (ok) return { done: true, ok: true, message: text(ok) };
    const bad = [...doc.querySelectorAll(pairs[kind][1])].filter(visible);
    if (bad.length) return { done: true, ok: false, message: bad.map(text).filter(Boolean).join('; ') || 'Validation error' };
  }
  // Generic: a thank-you page or message replacing the form.
  const body = text(doc.body).slice(0, 20000);
  const thanks = /thank you|thanks for|message (has been|was) sent|we('|’)ll be in touch|we will (get back|be in touch|contact you)|successfully (sent|submitted)|received your (message|enquiry)/i.exec(body);
  if (thanks && (!form || !visible(form) || /thank|success/i.test(location.href))) return { done: true, ok: true, message: thanks[0] };
  return { done: false };
}

/**
 * @param {object} o
 * @param {string} o.url       page with the form
 * @param {string} o.ref       reference code put in the message
 * @param {object} o.contact   { name, email, phone, message }
 * @param {string} [o.siteId]  for the screenshot filename
 * @param {boolean} [o.show]   run with a visible browser window
 * @returns {Promise<object>}  { status: sent|failed|blocked|no_form|error, ... }
 */
export async function runFormTest({ url, ref, contact, siteId = 'site', show = false }) {
  if (!contact?.email) return { status: 'error', url, ref, message: `Agency "${contact?.label || 'Default'}" has no email address - set one in Settings → Agencies. Forms need a real email to accept the submission.` };
  const b = await browser(!show);
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'en-AU' });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  const shot = path.join(SCREENS_DIR, `${siteId}-${Date.now()}.jpg`);
  const result = { url, ref, kind: null, fields: [], captcha: null };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    // Cookie banners can sit on top of the submit button.
    for (const sel of ['#cookie_action_close_header', '.cky-btn-accept', '#onetrust-accept-btn-handler', '.cmplz-accept', '#cn-accept-cookie', 'button:has-text("Accept all")', 'button:has-text("Accept")']) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click({ timeout: 2000 }).catch(() => {}); break; }
    }

    const plan = await page.evaluate(
      new Function('args', `const CAPTCHA_SEL_IN_PAGE = ${JSON.stringify(CAPTCHA_SEL)}; return (${planInPage.toString()})(args);`),
      { kinds: FORM_KINDS, contact, ref },
    );
    if (!plan.found) return { ...result, status: 'no_form', message: 'No contact form found on this page.' };
    Object.assign(result, { kind: plan.kind, captcha: plan.captcha });
    if (plan.captcha) return { ...result, status: 'blocked', message: `The form uses ${plan.captcha}, which blocks automated submissions. Test it by hand.` };
    if (!plan.hasSubmit) return { ...result, status: 'error', message: 'Found the form but no submit button.' };

    const form = page.locator('[data-cc-form]');
    await form.scrollIntoViewIfNeeded().catch(() => {});
    for (const f of plan.fields) {
      if (f.action === 'skip') { result.fields.push({ label: f.label, value: '(left empty)', ...(f.rule ? { rule: f.rule } : {}), ...(f.note ? { error: f.note } : {}) }); continue; }
      const el = page.locator(`[data-cc-field="${f.id}"]`);
      try {
        if (f.action === 'fill') await el.fill(f.value, { timeout: 5000 });
        else if (f.action === 'select') await el.selectOption(f.value, { timeout: 5000, force: true });
        else if (f.action === 'check') await el.check({ timeout: 5000, force: true });
        result.fields.push({ label: f.label, value: f.action === 'check' ? '✓' : f.value, ...(f.shown ? { shown: f.shown } : {}), ...(f.rule ? { rule: f.rule } : {}) });
      } catch (e) {
        result.fields.push({ label: f.label, value: f.value, error: e.message.split('\n')[0] });
      }
    }

    const before = page.url();
    await page.locator('[data-cc-submit]').click({ timeout: 10_000 });

    // Watch for the plugin's verdict, across an AJAX update or a full page load.
    const deadline = Date.now() + 25_000;
    let outcome = { done: false };
    while (Date.now() < deadline && !outcome.done) {
      await page.waitForTimeout(700);
      outcome = await page.evaluate(outcomeInPage, plan.kind).catch(() => ({ done: false }));
    }
    await page.screenshot({ path: shot, type: 'jpeg', quality: 70 }).catch(() => {});
    result.screenshot = fs.existsSync(shot) ? path.basename(shot) : null;
    result.finalUrl = page.url() !== before ? page.url() : undefined;
    if (!outcome.done) return { ...result, status: 'unknown', message: 'Submitted, but the page showed no success or error message within 25 s. Check the screenshot and the inbox.' };
    const v3 = plan.recaptchaV3 && !outcome.ok ? ' (the site uses invisible reCAPTCHA v3, which can flag automated tests as spam)' : '';
    return { ...result, status: outcome.ok ? 'sent' : 'failed', message: (outcome.message || (outcome.ok ? 'Sent' : 'Failed')) + v3 };
  } catch (e) {
    await page.screenshot({ path: shot, type: 'jpeg', quality: 70 }).catch(() => {});
    return { ...result, status: 'error', message: e.message.split('\n')[0], screenshot: fs.existsSync(shot) ? path.basename(shot) : null };
  } finally {
    await ctx.close().catch(() => {});
  }
}
