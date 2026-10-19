// Jobs: one action across one or more sites, with live progress.
//
// A job holds one entry per site with an ordered list of steps. Sites run in
// parallel up to the concurrency setting; steps on one site always run one at
// a time, so when something breaks it is clear which update did it.
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { call, externalCheck, LONG, WPError } from './wp.js';
import { getSite, getSettings, siteState, patchSiteState, addHistory, agencyFor } from './store.js';
import { runFormTest } from './formtest.js';
import { appendTextLog, notify, summarize } from './log.js';
import { postResults, postAfterFormTest } from './asana.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const jobs = new Map();       // id -> job
const busySites = new Set();  // a site runs one job at a time

function emitJob(job) { bus.emit('job', publicJob(job)); }

export function publicJob(job) {
  return { id: job.id, type: job.type, title: job.title, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, sites: job.sites };
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(publicJob);
}

function errInfo(e) {
  if (e instanceof WPError) return { code: e.code, message: e.message, data: e.data };
  return { code: 'error', message: e?.message || String(e) };
}

// ── Overview cache ───────────────────────────────────────────────────────────

export async function refreshOverview(siteId, { recheck = true } = {}) {
  const site = getSite(siteId);
  if (!site) throw new Error(`Unknown site ${siteId}`);
  try {
    const data = await call(site, 'GET', '/maintenance/overview', { params: recheck ? { refresh: '1' } : null, timeout: 120_000 });
    const st = patchSiteState(siteId, { overview: data, overviewAt: new Date().toISOString(), overviewError: null });
    bus.emit('site', { id: siteId, state: st });
    return data;
  } catch (e) {
    // Older plugin versions have no /maintenance routes: say so plainly.
    const info = errInfo(e);
    if (info.code === 'rest_no_route') info.message = 'This site runs a Claude Connector older than 1.8.0 - update the plugin on it first (WP Admin → Plugins).';
    const st = patchSiteState(siteId, { overviewError: info, overviewAt: new Date().toISOString() });
    bus.emit('site', { id: siteId, state: st });
    throw e;
  }
}

// ── Job plumbing ─────────────────────────────────────────────────────────────

function newRef() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

/**
 * @param {object} spec  { type, title, sites: [ids], ...options }
 * @param {Function} worker  async (ctx) => summary, run once per site
 */
function startJob(spec, worker) {
  const job = {
    id: crypto.randomUUID(), type: spec.type, title: spec.title, status: 'running',
    createdAt: new Date().toISOString(), finishedAt: null, sites: {},
  };
  for (const id of spec.sites) {
    const site = getSite(id);
    job.sites[id] = { name: site?.name || id, status: site ? 'queued' : 'failed', steps: [], summary: site ? null : 'Unknown site' };
  }
  jobs.set(job.id, job);
  emitJob(job);

  const queue = spec.sites.filter(id => job.sites[id].status === 'queued');
  const limit = Math.max(1, getSettings().concurrency || 4);
  let active = 0;

  const runOne = async (id) => {
    const entry = job.sites[id];
    if (busySites.has(id)) {
      entry.status = 'skipped';
      entry.summary = 'Another job is already running on this site.';
      emitJob(job);
      return;
    }
    busySites.add(id);
    entry.status = 'running';
    entry.startedAt = new Date().toISOString();
    emitJob(job);
    const ctx = makeCtx(job, id, spec);
    try {
      const summary = await worker(ctx);
      entry.status = ctx.failed ? 'failed' : ctx.warned ? 'warning' : 'ok';
      entry.summary = summary || null;
    } catch (e) {
      ctx.step(`Stopped: ${errInfo(e).message}`, 'failed');
      entry.status = 'failed';
      entry.summary = errInfo(e).message;
    } finally {
      busySites.delete(id);
      entry.finishedAt = new Date().toISOString();
      const record = { jobId: job.id, type: job.type, title: job.title, site: id, siteName: entry.name, status: entry.status, summary: entry.summary, steps: entry.steps, at: entry.finishedAt };
      // Results go on the site's Asana task - recorded as one more step, after the comment is built.
      if (['maintain', 'formtest'].includes(job.type)) {
        try {
          const posted = job.type === 'maintain'
            ? await postResults(id, record, new Date(entry.finishedAt) - new Date(entry.startedAt))
            : await postAfterFormTest(id, record);
          if (posted?.deferred) {
            entry.steps.push({ label: `Asana comment for ${posted.project ? `${posted.project} › ` : ''}${posted.task} will go out with the morning form test`, status: 'ok', detail: null, at: new Date().toISOString(), meta: { kind: 'asana', result: 'ok' } });
          } else if (posted) {
            const time = typeof posted.time === 'number' ? ` · ${posted.time} min added to Actual time` : posted.time ? ` · time not logged: ${posted.time}` : '';
            entry.steps.push({ label: `Posted to Asana: ${posted.project ? `${posted.project} › ` : ''}${posted.task}${time}`, status: 'ok', detail: null, at: new Date().toISOString(), meta: { kind: 'asana', result: 'ok' } });
          }
        } catch (e) {
          entry.steps.push({ label: `Could not post to Asana: ${e.message}`, status: 'warning', detail: null, at: new Date().toISOString(), meta: { kind: 'asana' } });
          if (entry.status === 'ok') entry.status = 'warning';
          record.status = entry.status;
        }
      }
      addHistory(record);
      appendTextLog(record);
      if (job.type === 'maintain') patchSiteState(id, { lastRun: { status: entry.status, summary: entry.summary, at: entry.finishedAt, jobId: job.id } });
      // Whatever the job saved for the site (security results, form test, Divi forms…) reaches open pages.
      bus.emit('site', { id });
      emitJob(job);
    }
  };

  const pump = () => new Promise(resolve => {
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < limit && queue.length) {
        const id = queue.shift();
        active++;
        runOne(id).finally(() => { active--; next(); });
      }
    };
    next();
  });

  pump().then(() => {
    job.status = Object.values(job.sites).some(s => s.status === 'failed') ? 'failed'
      : Object.values(job.sites).some(s => s.status === 'warning') ? 'warning' : 'done';
    job.finishedAt = new Date().toISOString();
    emitJob(job);
    if (getSettings().notifyOnFailure !== false && job.status === 'failed') {
      const bad = Object.values(job.sites).filter(s => s.status === 'failed');
      const what = bad.map(s => {
        const f = summarize(s).failed[0];
        return `${s.name}: ${f ? f.label : s.summary || 'failed'}`;
      });
      notify(`${job.title}: ${bad.length} site${bad.length === 1 ? '' : 's'} failed`, what.join(' · '));
    }
  });
  return publicJob(job);
}

function makeCtx(job, id, spec) {
  const entry = job.sites[id];
  const ctx = {
    site: getSite(id),
    spec,
    failed: false,
    warned: false,
    // meta: { kind, result: updated|skipped|failed|current|ok, name, from, to } - what the Log reads.
    step(label, status = 'running', detail = null, meta = null) {
      const s = { label, status, detail, at: new Date().toISOString(), ...(meta ? { meta } : {}) };
      entry.steps.push(s);
      if (status === 'failed') ctx.failed = true;
      if (status === 'warning') ctx.warned = true;
      emitJob(job);
      return {
        set(status2, label2, detail2, meta2) {
          s.status = status2;
          if (label2) s.label = label2;
          if (detail2 !== undefined) s.detail = detail2;
          if (meta2) s.meta = { ...(s.meta || {}), ...meta2 };
          if (status2 === 'failed') ctx.failed = true;
          if (status2 === 'warning') ctx.warned = true;
          emitJob(job);
        },
      };
    },
    api(method, endpoint, o) { return call(ctx.site, method, endpoint, o); },
  };
  return ctx;
}

// ── Steps shared by job types ────────────────────────────────────────────────

const label = r => r.name || r.item;

/** One update request, recorded as a step. Returns the result or null on failure. */
/** Installed and offered version of an item, from the cached overview. */
function versionsOf(siteId, type, item) {
  const ov = siteState(siteId).overview;
  if (!ov) return {};
  if (type === 'plugin') { const p = ov.plugins.find(x => x.file === item); return { from: p?.version, to: p?.update?.version }; }
  if (type === 'theme') { const t = ov.themes.find(x => x.stylesheet === item); return { from: t?.version, to: t?.update?.version }; }
  if (type === 'core') return { from: ov.core.version, to: ov.core.minor?.version || ov.core.major?.version };
  return {};
}

/** One update request, recorded as a step. Returns the result or null on failure. */
async function updateStep(ctx, type, item, name, extra = {}) {
  const v = versionsOf(ctx.site.id, type, item);
  const meta = { kind: type, name, item, from: v.from, to: v.to };
  const st = ctx.step(`Updating ${name}…`, 'running', null, meta);
  try {
    const r = await ctx.api('POST', '/maintenance/update', { body: { type, item, ...extra }, timeout: LONG });
    if (r.status === 'up_to_date') {
      st.set('ok', `${name}: already up to date${r.note ? ` - ${r.note}` : ''}`, undefined, { result: 'current' });
      return r;
    }
    const h = r.health?.status;
    const ver = r.from && r.to ? ` ${r.from} → ${r.to}` : r.count != null ? ` (${r.count} of ${r.of})` : '';
    const done = { result: 'updated', from: r.from ?? meta.from, to: r.to ?? meta.to };
    if (h === 'unverified') st.set('warning', `${label(r)}${ver} - updated, but the site could not be checked from the inside`, r.health.message, done);
    else if (h === 'fatal') st.set('failed', `${label(r)}${ver} - updated, and the site now shows a fatal error`, r.health.message, { ...done, result: 'failed' });
    else st.set('ok', `${label(r)}${ver}`, null, done);
    return r;
  } catch (e) {
    const i = errInfo(e);
    if (i.code === 'update_rolled_back') st.set('failed', `${name} ${i.data?.to || meta.to || ''}: broke the site - rolled back to ${i.data?.from || meta.from}`, i.message, { result: 'failed' });
    else if (i.code === 'no_package') st.set('warning', `${name} ${meta.to || ''}: not updated - needs a licence key`, i.message, { result: 'skipped', reason: 'licence' });
    else st.set('failed', `${name}${meta.to ? ` → ${meta.to}` : ''}: ${i.message}`, i.data ? JSON.stringify(i.data).slice(0, 500) : null, { result: 'failed' });
    return null;
  }
}

async function healthStep(ctx, title = 'Site health') {
  const st = ctx.step(`${title}…`);
  const [inside, outside] = await Promise.all([
    ctx.api('GET', '/maintenance/health', { timeout: 90_000 }).catch(e => ({ status: 'error', message: errInfo(e).message })),
    externalCheck(siteState(ctx.site.id).overview?.home_url || `${ctx.site.url}/`),
  ]);
  const fatal = inside.status === 'fatal' || outside.status === 'fatal';
  const warn = !fatal && (inside.status !== 'ok' || outside.status !== 'ok' || inside.stuck_maintenance);
  const bits = [];
  if (inside.status !== 'ok') bits.push(`inside: ${inside.message || inside.status}`);
  if (outside.status !== 'ok') bits.push(`homepage: ${outside.message}`);
  if (inside.stuck_maintenance) bits.push('a .maintenance file from an interrupted update is still in place');
  st.set(fatal ? 'failed' : warn ? 'warning' : 'ok', `${title}: ${fatal ? 'broken' : warn ? 'check needed' : `ok (homepage ${outside.code}, ${outside.ms} ms)`}`, bits.join(' · ') || null, { kind: 'health', result: fatal ? 'failed' : 'ok' });
  const health = { inside, outside, status: fatal ? 'fatal' : warn ? 'warning' : 'ok', at: new Date().toISOString() };
  patchSiteState(ctx.site.id, { health });
  return health;
}

/**
 * The read-only security check as a step of a run. "Cleaned" means the
 * previous check had warning signs and this one has none.
 */
async function securityStep(ctx) {
  const prev = siteState(ctx.site.id).security?.summary?.high || 0;
  const st = ctx.step('Security check…');
  try {
    const scan = await ctx.api('GET', '/security/scan', { timeout: 240_000 });
    patchSiteState(ctx.site.id, { security: { ...scan, at: new Date().toISOString() } });
    const high = scan.summary?.high || 0;
    const cleaned = prev > 0 && high === 0;
    st.set(high ? 'warning' : 'ok',
      high ? `Security check: ${high} high-severity warning sign${high === 1 ? '' : 's'} - see the Security tab` : cleaned ? 'Security check: clean now (warning signs found before are gone)' : 'Security check: no warning signs',
      null, { kind: 'security', high, medium: scan.summary?.medium || 0, cleaned });
  } catch (e) {
    const i = errInfo(e);
    // Older connectors have no security check: not a failure of the run.
    st.set('ok', i.code === 'rest_no_route' ? 'Security check skipped - needs Claude Connector 1.8.2 or newer' : `Security check could not run: ${i.message}`, null, { kind: 'security-skipped' });
  }
}

/** Picks the form page, submits the form, falls back to a wp_mail() test. */
async function formStep(ctx, { url } = {}) {
  const settings = getSettings();
  const agency = agencyFor(ctx.site.id);
  const st = ctx.step('Form test: finding the form…');
  let target = url || siteState(ctx.site.id).formUrl;
  let forms = [];
  let mailer = null;
  try {
    const r = await ctx.api('GET', '/maintenance/forms', { timeout: 60_000 });
    forms = r.forms || [];
    mailer = r.mailer;
    patchSiteState(ctx.site.id, { forms, mailer });
  } catch (e) {
    if (!target) { st.set('failed', `Form test: could not list forms - ${errInfo(e).message}`, null, { kind: 'form', form: 'error', result: 'failed' }); return null; }
  }
  // Contact pages first, then site-wide forms (Theme Builder / Elementor templates);
  // job applications, newsletter sign-ups and logins last.
  const NOT_CONTACT = /career|job|employ|recruit|vacanc|apply|application|newsletter|subscribe|login|register|sign-?up/i;
  const rank = f => (f.contact ? 3 : 0) + (f.via && f.via !== 'content' ? 1 : 0) - (NOT_CONTACT.test(`${f.title} ${f.url}`) ? 5 : 0);
  forms = [...forms].sort((a, b) => rank(b) - rank(a));
  if (!target && forms.length) target = forms[0].url;

  const ref = newRef();
  if (!target) {
    if (!settings.mailTestWhenNoForm) { st.set('warning', 'Form test: no contact form found on the site', null, { kind: 'form', form: 'no_form' }); return { status: 'no_form' }; }
    st.set('running', 'No contact form found - sending a wp_mail() test instead…');
    try {
      const m = await ctx.api('POST', '/maintenance/test-email', { body: { to: agency.email || undefined, ref }, timeout: 60_000 });
      const result = { status: m.sent ? 'mail_sent' : 'mail_failed', ref, to: m.to, message: m.error || (m.sent ? `wp_mail() accepted the message to ${m.to}` : 'wp_mail() returned false'), mailer: m.mailer, at: new Date().toISOString() };
      patchSiteState(ctx.site.id, { formTest: result, formTestQueued: null });
      st.set(m.sent ? (m.mailer?.plugin ? 'ok' : 'warning') : 'failed', `No contact form - mail test ${m.sent ? 'sent' : 'failed'} (ref ${ref})${m.mailer?.plugin ? ` via ${m.mailer.plugin}` : ''}`, m.error || m.mailer?.warning || null,
        { kind: 'form', form: m.sent ? 'mail_sent' : 'mail_failed', result: m.sent ? 'ok' : 'failed', ref });
      return result;
    } catch (e) { st.set('failed', `Mail test: ${errInfo(e).message}`); return null; }
  }

  st.set('running', `Form test: submitting the form on ${target} as "${agency.label}"…`);
  let r;
  try {
    r = await runFormTest({ url: target, ref, contact: agency, siteId: ctx.site.id, show: settings.showBrowser });
  } catch (e) {
    r = { status: 'error', url: target, ref, message: e.message };
  }
  r.at = new Date().toISOString();
  r.mailer = mailer;
  r.agency = agency.label;
  patchSiteState(ctx.site.id, { formTest: r, formTestQueued: null });
  const kind = r.kind ? ` (${r.kind})` : '';
  const map = {
    sent: ['ok', `Form test sent${kind} - ref ${ref}`],
    failed: ['failed', `Form test failed${kind}`],
    blocked: ['warning', `Form test blocked by ${r.captcha}${kind}`],
    unknown: ['warning', `Form test: no confirmation shown${kind}`],
    no_form: ['warning', 'Form test: no form on that page'],
    error: ['failed', 'Form test could not run'],
  };
  const [status, text] = map[r.status] || ['warning', `Form test: ${r.status}`];
  st.set(status, text, [r.message, mailer?.warning].filter(Boolean).join(' · ') || null, { kind: 'form', result: status === 'failed' ? 'failed' : 'ok', ref, form: r.status });
  return r;
}

// ── Job types ────────────────────────────────────────────────────────────────

/** Everything: health → plugins → themes → core → translations → Claude Connector → health → form. */
/**
 * @param {object}   o
 * @param {string[]} o.sites
 * @param {object}   [o.exclude]  { siteId: [keys] } left out of this run, e.g. "plugin:akismet/akismet.php", "theme:astra", "core", "translations"
 */
export function startMaintain({ sites, allowMajorCore, formTest, exclude = {} }) {
  const settings = getSettings();
  allowMajorCore = allowMajorCore ?? settings.allowMajorCore;
  // formTest: 'now' | 'queue' | 'off' (true/false accepted from older callers).
  formTest = formTest === true ? 'now' : formTest === false ? 'off' : (formTest || settings.formTestMode);
  return startJob({ type: 'maintain', title: `Update everything${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    const ov0 = await (async () => {
      const st = ctx.step('Checking for updates…');
      const o = await refreshOverview(ctx.site.id);
      const n = o.plugins.filter(p => p.update).length + o.themes.filter(t => t.update).length + (o.core.minor || (allowMajorCore && o.core.major) ? 1 : 0);
      st.set('ok', `${n} update${n === 1 ? '' : 's'} available · WordPress ${o.core.version} · PHP ${o.php_version}`);
      return o;
    })();

    // Everything there is to do, so whatever is not reached is logged as not done.
    const planned = [
      ...ov0.plugins.filter(p => p.update && !p.self).map(p => ({ key: `plugin:${p.file}`, type: 'plugin', item: p.file, name: p.name, from: p.version, to: p.update.version, u: p.update })),
      ...ov0.themes.filter(t => t.update).map(t => ({ key: `theme:${t.stylesheet}`, type: 'theme', item: t.stylesheet, name: t.name, from: t.version, to: t.update.version, u: t.update })),
      ...((ov0.core.minor || (allowMajorCore && ov0.core.major)) ? [{ key: 'core', type: 'core', item: '', name: 'WordPress', from: ov0.core.version, to: (allowMajorCore && ov0.core.major ? ov0.core.major : ov0.core.minor).version }] : []),
      ...(ov0.translations > 0 ? [{ key: 'translations', type: 'translations', item: '', name: 'Translations' }] : []),
      // The connector last: if it changes something, every other update is already in.
      ...ov0.plugins.filter(p => p.update && p.self).map(p => ({ key: `plugin:${p.file}`, type: 'plugin', item: p.file, name: p.name, from: p.version, to: p.update.version, u: p.update })),
    ];
    const handled = new Set();
    const notDone = (it, why, reason) => {
      handled.add(it.key);
      ctx.step(`${it.name}${it.to ? ` ${it.to}` : ''}: not updated - ${why}`, 'warning', null, { kind: it.type, name: it.name, item: it.item, from: it.from, to: it.to, result: 'skipped', reason });
    };

    let done = 0, failed = 0, skipped = 0, left = 0;
    const held = new Set(siteState(ctx.site.id).held || []);
    const excluded = new Set(exclude[ctx.site.id] || []);
    let pre;
    try {
      pre = await healthStep(ctx, 'Health before updating');
      if (pre.status === 'fatal') {
        ctx.step('Not updating: the site was already broken before any change', 'failed');
        for (const it of planned) notDone(it, 'the site was already broken', 'broken-before');
        return 'Site was already broken - nothing updated';
      }
      if (ov0.core.major && !allowMajorCore) {
        ctx.step(`WordPress ${ov0.core.major.version}: not updated - major update (allow it in Settings or update core on its own)`, 'ok', null,
          { kind: 'core', name: 'WordPress', from: ov0.core.version, to: ov0.core.major.version, result: 'skipped', reason: 'major' });
      }
      for (const it of planned) {
        if (held.has(it.key)) { notDone(it, `held - kept at ${it.from || 'the installed version'} on purpose`, 'held'); left++; continue; }
        if (excluded.has(it.key)) { notDone(it, 'left out of this run', 'excluded'); left++; continue; }
        if (it.u && it.u.php_ok === false) { notDone(it, `needs PHP ${it.u.requires_php} (site runs ${ov0.php_version})`, 'php'); skipped++; continue; }
        if (it.u && !it.u.package) { notDone(it, 'needs a licence key', 'licence'); skipped++; continue; }
        handled.add(it.key);
        const r = await updateStep(ctx, it.type, it.item, it.name, it.type === 'core' ? { allow_major: !!allowMajorCore } : {});
        if (r === null) failed++; else if (r.status === 'updated') done++;
      }
    } finally {
      // A run that stopped part-way (lost connection, timeout) still says what it did not get to.
      for (const it of planned) if (!handled.has(it.key)) notDone(it, 'the run stopped before reaching it', 'stopped');
    }

    await refreshOverview(ctx.site.id).catch(() => {});
    const post = await healthStep(ctx, 'Health after updating');
    if (post.status !== 'fatal' && getSettings().securityAfterUpdate !== false) await securityStep(ctx);
    let form = null;
    if (post.status !== 'fatal' && formTest === 'now') form = await formStep(ctx);
    if (post.status !== 'fatal' && formTest === 'queue') {
      patchSiteState(ctx.site.id, { formTestQueued: new Date().toISOString() });
      const sc = getSettings().schedule;
      ctx.step(sc.enabled ? `Form test queued for the morning run (${sc.time})` : 'Form test queued - turn on the morning run in Settings, or run the queue by hand', sc.enabled ? 'ok' : 'warning', null, { kind: 'form-queued' });
    }

    const parts = [`${done} updated`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (left) parts.push(`${left} left out`);
    if (post.status !== 'ok') parts.push(`health: ${post.status}`);
    if (form) parts.push(`form: ${form.status}`);
    if (formTest === 'queue' && post.status !== 'fatal') parts.push('form test queued');
    return parts.join(' · ');
  });
}

/** Selected items on one or more sites: [{ type, item, name }]. */
export function startUpdate({ sites, items, allowMajorCore = false }) {
  return startJob({ type: 'update', title: items.length === 1 ? `Update ${items[0].name || items[0].type}` : `Update ${items.length} items`, sites }, async (ctx) => {
    let done = 0, failed = 0;
    // Plugins first, Claude Connector last, as in a full run.
    const self = siteState(ctx.site.id).overview?.plugins?.find(p => p.self)?.file;
    const ordered = [...items].sort((a, b) => (a.item === self) - (b.item === self));
    for (const it of ordered) {
      const r = await updateStep(ctx, it.type, it.item || '', it.name || it.item || it.type, it.type === 'core' ? { allow_major: !!allowMajorCore } : {});
      if (r === null) failed++; else if (r.status === 'updated') done++;
    }
    await refreshOverview(ctx.site.id).catch(() => {});
    return `${done} updated${failed ? ` · ${failed} failed` : ''}`;
  });
}

/**
 * Plugin actions. Either explicit files (one site, from its plugin table) or a
 * slug resolved on each site (bulk across sites).
 */
export function startPluginAction({ sites, action, files, slug, version, activate }) {
  const verb = { install: 'Install', activate: 'Activate', deactivate: 'Deactivate', delete: 'Delete', update: 'Update' }[action];
  if (!verb) throw new Error(`Unknown plugin action ${action}`);
  const what = slug || (files?.length === 1 ? files[0] : `${files?.length || 0} plugins`);
  return startJob({ type: 'plugin', title: `${verb} ${what}${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    const ov = siteState(ctx.site.id).overview || await refreshOverview(ctx.site.id, { recheck: false });
    if (action === 'install') {
      const st = ctx.step(`Installing ${slug}${version ? ` ${version}` : ''}…`);
      try {
        const r = await ctx.api('POST', '/plugins', { body: { action: 'install', slug, version: version || undefined, activate: !!activate, overwrite: !!version }, timeout: LONG });
        st.set('ok', `${r.name} ${r.version} ${r.status === 'replaced' ? `installed over ${r.from}` : 'installed'}${r.active ? ' and activated' : ''}`, null,
          { kind: 'install', name: r.name, item: r.file, from: r.from || null, to: r.version, result: 'updated' });
      } catch (e) {
        const i = errInfo(e);
        st.set(i.code === 'already_installed' ? 'ok' : 'failed', i.code === 'already_installed' ? `${slug} is already installed` : `${slug}: ${i.message}`);
      }
      await refreshOverview(ctx.site.id, { recheck: false }).catch(() => {});
      return null;
    }

    let targets = files || [];
    if (slug) {
      const p = ov.plugins.find(p => p.slug === slug || p.file.split('/')[0] === slug || p.file === slug);
      if (!p) { ctx.step(`${slug} is not installed here`, 'ok'); return 'not installed'; }
      targets = [p.file];
    }
    for (const file of targets) {
      const p = ov.plugins.find(x => x.file === file);
      const name = p?.name || file;
      if (action === 'update') { await updateStep(ctx, 'plugin', file, name); continue; }
      if (action === 'activate' && p?.active) { ctx.step(`${name} is already active`, 'ok'); continue; }
      if (action === 'deactivate' && p && !p.active) { ctx.step(`${name} is already inactive`, 'ok'); continue; }
      const st = ctx.step(`${verb.replace(/e$/, '')}ing ${name}…`);
      try {
        const r = await ctx.api('POST', '/plugins', { body: { action, plugin: file }, timeout: 120_000 });
        const h = r.health?.status;
        st.set(h === 'unverified' ? 'warning' : 'ok', `${name} ${action === 'delete' ? 'deleted' : `${action}d`}`, h === 'unverified' ? r.health.message : null);
      } catch (e) {
        st.set('failed', `${name}: ${errInfo(e).message}`);
      }
    }
    await refreshOverview(ctx.site.id, { recheck: false }).catch(() => {});
    return null;
  });
}

export function startRefresh({ sites }) {
  return startJob({ type: 'refresh', title: `Check ${sites.length} site${sites.length === 1 ? '' : 's'} for updates`, sites }, async (ctx) => {
    const st = ctx.step('Checking for updates…');
    const o = await refreshOverview(ctx.site.id);
    const n = o.plugins.filter(p => p.update).length + o.themes.filter(t => t.update).length + (o.core.minor ? 1 : 0);
    st.set('ok', `${n} update${n === 1 ? '' : 's'} available`);
    await healthStep(ctx);
    return `${n} updates available`;
  });
}

/**
 * Read-only check before updating: pending updates, health, the security scan
 * and Divi email patterns. Changes nothing - the counterpart to Update everything.
 */
export function startCheck({ sites }) {
  return startJob({ type: 'check', title: `Check everything${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    const st = ctx.step('Checking for updates…');
    const o = await refreshOverview(ctx.site.id);
    const n = o.plugins.filter(p => p.update).length + o.themes.filter(t => t.update).length + (o.core.minor || o.core.major ? 1 : 0);
    st.set('ok', `${n} update${n === 1 ? '' : 's'} available · WordPress ${o.core.version} · PHP ${o.php_version}`);
    const health = await healthStep(ctx);
    if (health.status !== 'fatal') { await securityStep(ctx); await diviFormsStep(ctx); }
    const sec = siteState(ctx.site.id).security?.summary;
    const parts = [`${n} update${n === 1 ? '' : 's'}`];
    if (health.status !== 'ok') parts.push(`health: ${health.status}`);
    if (sec?.high) parts.push(`${sec.high} security`);
    return parts.join(' · ');
  });
}

/** The Divi form check as a step (shared by Check and the standalone job). */
async function diviFormsStep(ctx) {
  const st = ctx.step('Checking Divi contact form email patterns…');
  try {
    const r = await ctx.api('GET', '/divi/forms', { timeout: 60_000 });
    patchSiteState(ctx.site.id, { diviForms: { ...r, at: new Date().toISOString() } });
    const forms = (r.forms || []).filter(f => f.fields.length);
    const bad = forms.filter(f => !f.ok);
    if (!forms.length) { st.set('ok', 'No Divi 4 contact forms'); return; }
    st.set(bad.length ? 'warning' : 'ok', bad.length ? `${bad.length} of ${forms.length} Divi form${forms.length === 1 ? '' : 's'} drop fields from the email` : `All ${forms.length} Divi form${forms.length === 1 ? '' : 's'} send every field`);
  } catch (e) {
    const i = errInfo(e);
    st.set('ok', i.code === 'rest_no_route' ? 'Divi form check skipped - needs Claude Connector 1.8.3 or newer' : `Divi form check skipped: ${i.message}`);
  }
}

export function queueFormTest({ sites, queued = true }) {
  for (const id of sites) {
    patchSiteState(id, { formTestQueued: queued ? new Date().toISOString() : null });
    bus.emit('site', { id });
  }
}

export function startFormTest({ sites, url, title }) {
  return startJob({ type: 'formtest', title: title || `Form test${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    const r = await formStep(ctx, { url: sites.length === 1 ? url : undefined });
    return r ? `${r.status}${r.ref ? ` · ref ${r.ref}` : ''}` : null;
  });
}

/** Read-only security check; results go to the site's Security tab. */
export function startSecurityScan({ sites }) {
  return startJob({ type: 'security', title: `Security check${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    const st = ctx.step('Running the security check (core and plugin checksums, malware patterns, uploads, admins)…');
    let scan;
    try {
      scan = await ctx.api('GET', '/security/scan', { timeout: 240_000 });
    } catch (e) {
      const i = errInfo(e);
      st.set('failed', i.code === 'rest_no_route' ? 'Security check needs Claude Connector 1.8.2 or newer on this site' : `Security check: ${i.message}`, null, { kind: 'security', result: 'failed' });
      return null;
    }
    patchSiteState(ctx.site.id, { security: { ...scan, at: new Date().toISOString() } });
    const s = scan.summary || {};
    const top = (scan.findings || []).filter(f => f.severity === 'high').map(f => `${f.title} (${f.count})`);
    st.set(s.high ? 'failed' : s.medium ? 'warning' : 'ok',
      s.high || s.medium ? `Security check: ${s.high} high, ${s.medium} medium` : 'Security check: no warning signs found',
      top.join(' · ') || null, { kind: 'security', result: s.high ? 'failed' : 'ok' });
    return s.high || s.medium ? `${s.high} high · ${s.medium} medium` : 'clean';
  });
}

/** Read-only: Divi contact forms whose email Message Pattern drops fields. */
export function startDiviFormsCheck({ sites }) {
  return startJob({ type: 'diviforms', title: `Check Divi forms${sites.length > 1 ? ` on ${sites.length} sites` : ''}`, sites }, async (ctx) => {
    await diviFormsStep(ctx);
    const bad = (siteState(ctx.site.id).diviForms?.forms || []).filter(f => f.fields.length && !f.ok);
    return bad.length ? `${bad.length} form(s) to fix` : 'all good';
  });
}

export function startMailTest({ sites }) {
  return startJob({ type: 'mailtest', title: 'Mail test', sites }, async (ctx) => {
    const ref = newRef();
    const st = ctx.step('Sending wp_mail() test…');
    const m = await ctx.api('POST', '/maintenance/test-email', { body: { to: agencyFor(ctx.site.id).email || undefined, ref }, timeout: 60_000 });
    st.set(m.sent ? (m.mailer?.plugin ? 'ok' : 'warning') : 'failed', `Mail ${m.sent ? 'accepted' : 'failed'} for ${m.to} (ref ${ref})${m.mailer?.plugin ? ` via ${m.mailer.plugin}` : ''}`, m.error || m.mailer?.warning || null);
    patchSiteState(ctx.site.id, { mailer: m.mailer });
    return m.sent ? `sent · ref ${ref}` : 'failed';
  });
}
