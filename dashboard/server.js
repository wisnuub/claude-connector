#!/usr/bin/env node
// Claude Connector maintenance dashboard - a local web app for running updates
// and form tests across many WordPress sites.
//
//   cd dashboard && npm install && npm start      → http://127.0.0.1:4590
//
// Listens on 127.0.0.1 only. API keys stay in this process and in data/.
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as store from './lib/store.js';
import * as jobs from './lib/jobs.js';
import { call } from './lib/wp.js';
import { closeBrowser } from './lib/formtest.js';
import { startScheduler, nextRun, scheduledSites } from './lib/scheduler.js';
import { summarize, LOG_DIR } from './lib/log.js';
import { previewConnect, confirmConnect } from './lib/connect.js';
import * as asana from './lib/asana.js';
import { logIn, closeLoginBrowser } from './lib/login.js';
import { openForClaude } from './lib/security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '4590', 10);
const HOST = '127.0.0.1';
const EXTENSION_DIR = path.join(ROOT, 'extension');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Body is not JSON')); } });
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/** What the browser gets per site: never the key. */
function publicSite(s) {
  const st = store.siteState(s.id);
  return {
    id: s.id, name: s.name, url: s.url, mode: s.relayUrl && s.relayKey ? 'relay' : s.mode || 'rest', source: s.source, hidden: s.hidden,
    overview: st.overview || null, overviewAt: st.overviewAt || null, overviewError: st.overviewError || null,
    health: st.health || null, lastRun: st.lastRun || null, formTest: st.formTest || null,
    forms: st.forms || null, formUrl: st.formUrl || null, mailer: st.mailer || st.overview?.mailer || null,
    agencyId: st.agencyId || null,
    security: st.security || null,
    diviForms: st.diviForms || null,
    formTestQueued: st.formTestQueued || null,
    held: st.held || [],
    asana: st.asana || null,
  };
}

function sitesOrThrow(ids) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('Pick at least one site.'), { status: 400 });
  for (const id of ids) if (!store.getSite(id)) throw Object.assign(new Error(`Unknown site ${id}`), { status: 404 });
  return ids;
}

/** The short Asana comment for a site's last run, updated with a later form test or security check. */
function asanaDraft(id) {
  const st = store.siteState(id);
  const last = store.getHistory({ site: id, limit: 100 }).find(h => h.type === 'maintain');
  const facts = st.asanaPending?.facts ? { ...st.asanaPending.facts } : last ? asana.runFacts(last) : { core: false, plugins: false, failed: [], form: null, security: null, at: null };
  if (st.formTest && (!facts.form || !facts.at || st.formTest.at > facts.at)) facts.form = { status: st.formTest.status, message: st.formTest.message };
  if (st.security?.at && (!facts.at || st.security.at > facts.at)) {
    const high = st.security.summary?.high || 0;
    facts.security = { high, cleaned: !!facts.security?.cleaned || (!!facts.security?.high && high === 0) };
  }
  return { text: asana.shortComment(facts), basedOn: last?.at || null, pending: !!st.asanaPending, task: st.asana || null };
}

function failuresInfo() {
  return store.openFailures().map(h => ({ site: h.site, siteName: h.siteName, title: h.title, at: h.at, summary: h.summary, first: summarize(h).failed[0]?.label || null }));
}

function scheduleInfo() {
  return { next: nextRun(), sites: scheduledSites().length, last: store.getMeta().lastScheduledResult || null };
}

const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
jobs.bus.on('job', j => broadcast('job', j));
jobs.bus.on('site', ({ id }) => { const s = store.getSite(id); if (s) broadcast('site', publicSite(s)); broadcast('schedule', scheduleInfo()); });
jobs.bus.on('job', j => { if (j.status !== 'running') { broadcast('schedule', scheduleInfo()); broadcast('failures', failuresInfo()); } });

// ── New sites ────────────────────────────────────────────────────────────────
// Watch ~/claude-sites (and sites.json) so a site added by the one-click
// installer shows up without a reload. fs.watch can miss events or fail when
// the folder does not exist yet, so a light poll backs it up.
const newSites = new Set();
let knownSites = new Map(store.listSites({ includeHidden: true }).map(s => [s.id, s.url]));
let rescanTimer = null;
function rescanSites() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    const now = store.listSites({ includeHidden: true });
    const added = now.filter(s => !knownSites.has(s.id));
    const changed = added.length || now.length !== knownSites.size || now.some(s => knownSites.get(s.id) !== s.url);
    knownSites = new Map(now.map(s => [s.id, s.url]));
    if (!changed) return;
    for (const s of added) newSites.add(s.id);
    broadcast('sites', { added: added.map(s => ({ id: s.id, name: s.name, url: s.url })) });
    if (added.length) console.log(`New site${added.length === 1 ? '' : 's'} found: ${added.map(s => s.name).join(', ')}`);
  }, 600);
}
for (const target of [store.SITES_DIR, path.dirname(store.MCP_SITES_FILE)]) {
  try { fs.watch(target, { recursive: process.platform !== 'linux' }, rescanSites); } catch {}
}
setInterval(rescanSites, 15_000);

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/state') {
    return send(res, 200, { version: VERSION, sites: store.listSites({ includeHidden: true }).map(publicSite), settings: store.getSettings(), jobs: jobs.listJobs(), schedule: scheduleInfo(), failures: failuresInfo(), newSites: [...newSites], logDir: LOG_DIR, extensionDir: EXTENSION_DIR });
  }
  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (m === 'GET' && p === '/api/log') {
    // Runs in the last N days, each with its steps sorted into updated / not done / failed / notice.
    const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10)));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const entries = store.getHistory({ since, limit: 2000 }).map(e => ({ ...e, log: summarize(e) }));
    return send(res, 200, { days, entries });
  }
  if (m === 'GET' && p === '/api/history') {
    return send(res, 200, store.getHistory({ site: url.searchParams.get('site') || undefined, limit: 30 }));
  }
  if (m === 'GET' && p === '/api/wporg') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return send(res, 200, []);
    const r = await fetch(`https://api.wordpress.org/plugins/info/1.2/?action=query_plugins&request[search]=${encodeURIComponent(q)}&request[per_page]=8&request[fields][short_description]=1&request[fields][icons]=0`);
    const d = await r.json();
    return send(res, 200, (d.plugins || []).map(x => ({ slug: x.slug, name: x.name.replace(/&#\d+;|&amp;/g, s => s === '&amp;' ? '&' : String.fromCharCode(parseInt(s.slice(2), 10))), version: x.version, installs: x.active_installs, rating: x.rating, short: x.short_description })));
  }

  if (m === 'GET' && p === '/api/asana/status') return send(res, 200, await asana.status());
  if (m === 'GET' && p === '/api/asana/tasks') {
    try { return send(res, 200, await asana.myTasks({ refresh: url.searchParams.get('refresh') === '1' })); }
    catch (e) { return send(res, e.status === 401 ? 401 : 502, { message: e.message }); }
  }
  if (m === 'GET' && p === '/api/asana/logins') {
    // Fetched when asked for, straight from Asana; not stored here.
    try { return send(res, 200, await asana.loginsFor(String(url.searchParams.get('task') || '').replace(/\D/g, ''))); }
    catch (e) { return send(res, e.status === 401 ? 401 : 502, { message: e.message }); }
  }
  if (m === 'GET' && p === '/api/wporg/versions') {
    const slug = (url.searchParams.get('slug') || '').replace(/[^a-z0-9-]/gi, '');
    const r = await fetch(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${slug}&request[fields][versions]=1&request[fields][sections]=0`);
    const d = await r.json();
    const versions = Object.keys(d.versions || {}).filter(v => v !== 'trunk' && /^\d/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 25);
    return send(res, 200, { slug, current: d.version || null, versions });
  }

  // Everything below changes something.
  if (m !== 'POST' && m !== 'DELETE') return send(res, 405, { message: 'Method not allowed' });
  const body = m === 'POST' ? await readBody(req) : {};

  if (p === '/api/settings') {
    const saved = store.saveSettings(body);
    jobs.bus.emit('settings');
    broadcast('schedule', scheduleInfo());
    return send(res, 200, saved);
  }
  if (p === '/api/sites' && m === 'POST') {
    store.addSite(body);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/sites/unhide') { store.unhideAll(); return send(res, 200, { ok: true }); }
  if (p === '/api/failures/dismiss') {
    store.patchMeta({ failuresAckAt: new Date().toISOString() });
    broadcast('failures', failuresInfo());
    return send(res, 200, { ok: true });
  }
  if (p === '/api/sites/held') {
    // { site, key: "plugin:<file>" | "theme:<stylesheet>" | "core" | "translations", held: bool }
    const site = store.getSite(body.site);
    if (!site || typeof body.key !== 'string') return send(res, 400, { message: 'site and key are required' });
    const held = new Set(store.siteState(site.id).held || []);
    body.held ? held.add(body.key) : held.delete(body.key);
    store.patchSiteState(site.id, { held: [...held] });
    broadcast('site', publicSite(site));
    return send(res, 200, { held: [...held] });
  }
  if (p === '/api/asana/connect') {
    try { return send(res, 200, await asana.connect(body.token)); }
    catch (e) { return send(res, e.status === 401 ? 400 : 502, { message: e.message }); }
  }
  if (p === '/api/asana/disconnect') { await asana.disconnect(); return send(res, 200, { ok: true }); }
  if (p === '/api/asana/link') {
    // { site, task: { gid, name, url, project } | null }
    if (!store.getSite(body.site)) return send(res, 404, { message: 'Unknown site' });
    asana.linkTask(body.site, body.task || null);
    broadcast('site', publicSite(store.getSite(body.site)));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/extension/reveal') {
    // Shows the extension folder in Finder, ready for Chrome's "Load unpacked".
    if (process.platform === 'darwin') spawn('open', ['-R', path.join(EXTENSION_DIR, 'manifest.json')], { stdio: 'ignore', detached: true }).unref();
    return send(res, 200, { dir: EXTENSION_DIR });
  }
  if (p === '/api/asana/site-url') {
    asana.rememberSiteUrl(String(body.project || ''), String(body.url || ''));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/login') {
    // { url, user, pass } - opens a browser window and signs in.
    try { return send(res, 200, await logIn(body)); }
    catch (e) { return send(res, 400, { message: e.message.split('\n')[0] }); }
  }
  if (p === '/api/connect/preview') {
    try { return send(res, 200, await previewConnect(body.link)); }
    catch (e) { return send(res, 400, { message: e.message }); } // a bad or used link, not a server fault
  }
  if (p === '/api/connect/confirm') {
    const r = await confirmConnect(body.id, { openEditor: body.openEditor !== false });
    // Pick the new workspace up now rather than on the watcher's next tick, so the agency can be set.
    const site = store.listSites({ includeHidden: true }).find(s => s.url.replace(/\/+$/, '') === r.url.replace(/\/+$/, ''));
    if (site && body.agencyId) store.patchSiteState(site.id, { agencyId: body.agencyId });
    rescanSites();
    return send(res, 200, { ...r, siteId: site?.id || null });
  }
  if (p === '/api/sites/seen') { newSites.clear(); return send(res, 200, { ok: true }); }
  if (p === '/api/sites/meta') {
    // { sites: [ids], agencyId?, formUrl? } - agencyId '' clears it (unassigned).
    for (const id of sitesOrThrow(body.sites)) {
      const patch = {};
      if ('agencyId' in body) patch.agencyId = body.agencyId || null;
      if ('formUrl' in body) patch.formUrl = body.formUrl || null;
      store.patchSiteState(id, patch);
      broadcast('site', publicSite(store.getSite(id)));
    }
    return send(res, 200, { ok: true });
  }
  let mm;
  if ((mm = p.match(/^\/api\/sites\/([\w-]+)$/)) && m === 'DELETE') {
    store.removeSite(mm[1]);
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/sites\/([\w-]+)\/divi-pattern$/))) {
    // { post_id, index, pattern } - sets one Divi form's Message Pattern, then re-checks the site.
    const site = store.getSite(mm[1]);
    if (!site) return send(res, 404, { message: 'Unknown site' });
    const r = await call(site, 'POST', '/divi/forms/pattern', { body: { post_id: body.post_id, index: body.index, pattern: body.pattern }, timeout: 60_000 });
    const forms = await call(site, 'GET', '/divi/forms', { timeout: 60_000 }).catch(() => null);
    if (forms) { store.patchSiteState(site.id, { diviForms: { ...forms, at: new Date().toISOString() } }); broadcast('site', publicSite(site)); }
    return send(res, 200, r);
  }
  if ((mm = p.match(/^\/api\/sites\/([\w-]+)\/asana-comment$/))) {
    // POST { text } sends it to the site's Asana task; POST {} returns a draft.
    const site = store.getSite(mm[1]);
    if (!site) return send(res, 404, { message: 'Unknown site' });
    if (typeof body.text === 'string') {
      const text = body.text.trim();
      if (!text) return send(res, 400, { message: 'The comment is empty.' });
      try {
        const r = await asana.postComment(site.id, { text });
        store.patchSiteState(site.id, { asanaPending: null });
        return send(res, 200, r);
      } catch (e) { return send(res, e.status === 401 ? 401 : 400, { message: e.message }); }
    }
    return send(res, 200, asanaDraft(site.id));
  }
  if ((mm = p.match(/^\/api\/sites\/([\w-]+)\/claude-review$/))) {
    // Last security check → SECURITY-REPORT.md in the site's workspace, opened in VS Code.
    const site = store.getSite(mm[1]);
    if (!site) return send(res, 404, { message: 'Unknown site' });
    const scan = store.siteState(site.id).security;
    if (!scan) return send(res, 400, { message: 'Run the security check first.' });
    return send(res, 200, await openForClaude(site, scan));
  }
  if ((mm = p.match(/^\/api\/sites\/([\w-]+)\/forms$/))) {
    const site = store.getSite(mm[1]);
    if (!site) return send(res, 404, { message: 'Unknown site' });
    const r = await call(site, 'GET', '/maintenance/forms', { timeout: 60_000 });
    store.patchSiteState(site.id, { forms: r.forms, mailer: r.mailer });
    broadcast('site', publicSite(site));
    return send(res, 200, r);
  }

  if (p === '/api/jobs') {
    const sites = sitesOrThrow(body.sites);
    switch (body.type) {
      case 'refresh': return send(res, 200, jobs.startRefresh({ sites }));
      case 'check': return send(res, 200, jobs.startCheck({ sites }));
      case 'maintain': return send(res, 200, jobs.startMaintain({ sites, allowMajorCore: body.allowMajorCore, formTest: body.formTest, exclude: body.exclude || {} }));
      case 'update': return send(res, 200, jobs.startUpdate({ sites, items: body.items || [], allowMajorCore: body.allowMajorCore }));
      case 'plugin': return send(res, 200, jobs.startPluginAction({ sites, action: body.action, files: body.files, slug: body.slug, version: body.version, activate: body.activate }));
      case 'formtest': return send(res, 200, jobs.startFormTest({ sites, url: body.url }));
      case 'queue-form': jobs.queueFormTest({ sites, queued: body.queued !== false }); return send(res, 200, { ok: true });
      case 'mailtest': return send(res, 200, jobs.startMailTest({ sites }));
      case 'security': return send(res, 200, jobs.startSecurityScan({ sites }));
      case 'diviforms': return send(res, 200, jobs.startDiviFormsCheck({ sites }));
      default: return send(res, 400, { message: `Unknown job type ${body.type}` });
    }
  }
  return send(res, 404, { message: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  // Only answer to our own name: a page elsewhere pointing a DNS name at
  // 127.0.0.1 (DNS rebinding) would otherwise be able to drive the API.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(421); return res.end('Misdirected request'); }

  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // A cross-site form post cannot set this header, and a fetch() that does needs a CORS preflight we never grant.
      if (req.method !== 'GET' && req.headers['x-cc-dashboard'] !== '1') return send(res, 403, { message: 'Missing X-CC-Dashboard header' });
      return await api(req, res, url);
    }
    if (url.pathname.startsWith('/screens/')) {
      const name = path.basename(url.pathname);
      return serveFile(res, path.join(store.SCREENS_DIR, name));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    return serveFile(res, file);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { message: e.message, code: e.code || null });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use - the dashboard may already be running (npm run service:status), or set PORT=...`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  startScheduler();
  const n = store.listSites().length;
  console.log(`Claude Connector dashboard ${VERSION} → http://${HOST}:${PORT}  (${n} site${n === 1 ? '' : 's'} found)`);
  console.log(`Data: ${store.DATA_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); await closeLoginBrowser(); process.exit(0); });
