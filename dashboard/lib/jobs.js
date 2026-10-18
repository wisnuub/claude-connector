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
      addHistory({ jobId: job.id, type: job.type, title: job.title, site: id, siteName: entry.name, status: entry.status, summary: entry.summary, steps: entry.steps, at: entry.finishedAt });
      if (job.type === 'maintain') patchSiteState(id, { lastRun: { status: entry.status, summary: entry.summary, at: entry.finishedAt, jobId: job.id } });
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
    step(label, status = 'running', detail = null) {
      const s = { label, status, detail, at: new Date().toISOString() };
      entry.steps.push(s);
      if (status === 'failed') ctx.failed = true;
      if (status === 'warning') ctx.warned = true;
      emitJob(job);
      return {
        set(status2, label2, detail2) {
          s.status = status2;
          if (label2) s.label = label2;
          if (detail2 !== undefined) s.detail = detail2;
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
async function updateStep(ctx, type, item, name, extra = {}) {
  const st = ctx.step(`Updating ${name}…`);
  try {
    const r = await ctx.api('POST', '/maintenance/update', { body: { type, item, ...extra }, timeout: LONG });
    if (r.status === 'up_to_date') {
      st.set('ok', `${name}: already up to date${r.note ? ` - ${r.note}` : ''}`);
      return r;
    }
    const h = r.health?.status;
    const ver = r.from && r.to ? ` ${r.from} → ${r.to}` : r.count != null ? ` (${r.count} of ${r.of})` : '';
    if (h === 'unverified') st.set('warning', `${label(r)}${ver} - updated, but the site could not be checked from the inside`, r.health.message);
    else if (h === 'fatal') st.set('failed', `${label(r)}${ver} - updated, and the site now shows a fatal error`, r.health.message);
    else st.set('ok', `${label(r)}${ver}`);
    return r;
  } catch (e) {
    const i = errInfo(e);
    if (i.code === 'update_rolled_back') st.set('failed', `${name}: the new version broke the site - rolled back to ${i.data?.from}`, i.message);
    else if (i.code === 'no_package') st.set('warning', `${name}: update needs a licence key - skipped`, i.message);
    else st.set('failed', `${name}: ${i.message}`, i.data ? JSON.stringify(i.data).slice(0, 500) : null);
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
  st.set(fatal ? 'failed' : warn ? 'warning' : 'ok', `${title}: ${fatal ? 'broken' : warn ? 'check needed' : `ok (homepage ${outside.code}, ${outside.ms} ms)`}`, bits.join(' · ') || null);
  const health = { inside, outside, status: fatal ? 'fatal' : warn ? 'warning' : 'ok', at: new Date().toISOString() };
  patchSiteState(ctx.site.id, { health });
  return health;
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
    if (!target) { st.set('failed', `Form test: could not list forms - ${errInfo(e).message}`); return null; }
  }
  if (!target && forms.length) target = forms[0].url;

  const ref = newRef();
  if (!target) {
    if (!settings.mailTestWhenNoForm) { st.set('warning', 'Form test: no contact form found on the site'); return null; }
    st.set('running', 'No contact form found - sending a wp_mail() test instead…');
    try {
      const m = await ctx.api('POST', '/maintenance/test-email', { body: { to: agency.email || undefined, ref }, timeout: 60_000 });
      const result = { status: m.sent ? 'mail_sent' : 'mail_failed', ref, to: m.to, message: m.error || (m.sent ? `wp_mail() accepted the message to ${m.to}` : 'wp_mail() returned false'), mailer: m.mailer, at: new Date().toISOString() };
      patchSiteState(ctx.site.id, { formTest: result, formTestQueued: null });
      st.set(m.sent ? (m.mailer?.plugin ? 'ok' : 'warning') : 'failed', `Mail test ${m.sent ? 'sent' : 'failed'} (ref ${ref})${m.mailer?.plugin ? ` via ${m.mailer.plugin}` : ''}`, m.error || m.mailer?.warning || null);
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
  st.set(status, text, [r.message, mailer?.warning].filter(Boolean).join(' · ') || null);
  return r;
}

// ── Job types ────────────────────────────────────────────────────────────────

/** Everything: health → plugins → themes → core → translations → Claude Connector → health → form. */
export function startMaintain({ sites, allowMajorCore, formTest }) {
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

    const pre = await healthStep(ctx, 'Health before updating');
    if (pre.status === 'fatal') {
      ctx.step('Not updating: the site was already broken before any change', 'failed');
      return 'Site was already broken - nothing updated';
    }

    let done = 0, failed = 0, skipped = 0;
    const count = r => { if (r === null) failed++; else if (r.status === 'updated') done++; };
    const plugins = ov0.plugins.filter(p => p.update && !p.self);
    for (const p of plugins) {
      if (!p.update.php_ok) { ctx.step(`${p.name}: ${p.update.version} needs PHP ${p.update.requires_php} - skipped`, 'warning'); skipped++; continue; }
      if (!p.update.package) { ctx.step(`${p.name}: ${p.update.version} needs a licence key - skipped`, 'warning'); skipped++; continue; }
      count(await updateStep(ctx, 'plugin', p.file, p.name));
    }
    for (const t of ov0.themes.filter(t => t.update)) {
      if (!t.update.package) { ctx.step(`${t.name}: ${t.update.version} needs a licence key - skipped`, 'warning'); skipped++; continue; }
      count(await updateStep(ctx, 'theme', t.stylesheet, t.name));
    }
    if (ov0.core.minor || (allowMajorCore && ov0.core.major)) {
      count(await updateStep(ctx, 'core', '', 'WordPress', { allow_major: !!allowMajorCore }));
    } else if (ov0.core.major) {
      ctx.step(`WordPress ${ov0.core.major.version} is a major update - skipped (allow it in Settings or update core on its own)`, 'ok');
    }
    if (ov0.translations > 0) count(await updateStep(ctx, 'translations', '', 'Translations'));
    // The connector last: if it changes something, every other update is already in.
    const self = ov0.plugins.find(p => p.update && p.self);
    if (self) count(await updateStep(ctx, 'plugin', self.file, self.name));

    await refreshOverview(ctx.site.id).catch(() => {});
    const post = await healthStep(ctx, 'Health after updating');
    let form = null;
    if (post.status !== 'fatal' && formTest === 'now') form = await formStep(ctx);
    if (post.status !== 'fatal' && formTest === 'queue') {
      patchSiteState(ctx.site.id, { formTestQueued: new Date().toISOString() });
      const sc = getSettings().schedule;
      ctx.step(sc.enabled ? `Form test queued for the morning run (${sc.time})` : 'Form test queued - turn on the morning run in Settings, or run the queue by hand', sc.enabled ? 'ok' : 'warning');
    }

    const parts = [`${done} updated`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} skipped`);
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
        st.set('ok', `${r.name} ${r.version} ${r.status === 'replaced' ? `installed over ${r.from}` : 'installed'}${r.active ? ' and activated' : ''}`);
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
