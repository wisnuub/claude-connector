// Sites, settings, cached overviews and run history - all plain JSON under
// dashboard/data/ (git-ignored: it holds API keys).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.CC_DASHBOARD_DATA || path.join(ROOT, 'data');
export const SCREENS_DIR = path.join(DATA_DIR, 'screens');
fs.mkdirSync(SCREENS_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Write to a temp file and rename, so a crash mid-write never leaves half a file.
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const F = {
  sites: path.join(DATA_DIR, 'sites.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  state: path.join(DATA_DIR, 'state.json'),
  history: path.join(DATA_DIR, 'history.json'),
};

// ── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_MESSAGE = 'This is an automated test message sent during routine website maintenance to confirm the contact form works. No reply needed. Ref: {ref}';

// Agencies: who a site is maintained for. Each has its own form-test details -
// what gets typed into a contact form - and its own rules for unusual fields.
// A site without an agency uses the default one's details.
export const DEFAULT_AGENCY = {
  id: 'default',
  label: 'My agency',
  color: '#2459d6',
  name: 'Website Maintenance',
  email: '',
  phone: '0400 000 000',
  company: 'Maintenance Test',
  subject: 'Website maintenance test {ref}',
  message: DEFAULT_MESSAGE,
  // Dropdowns and radio groups no rule covers: 'first' real option, or 'random'.
  choices: 'first',
  rules: [],
};

export const DEFAULT_SETTINGS = {
  agencies: [DEFAULT_AGENCY],
  defaultAgency: 'default',
  concurrency: 4,
  allowMajorCore: false,
  // After "Update everything": 'now' runs the form test straight away,
  // 'queue' leaves it for the scheduled morning run, 'off' skips it.
  formTestMode: 'queue',
  mailTestWhenNoForm: true,
  showBrowser: false,
  notifyOnFailure: true,
  // workspace: Asana workspace gid. The token itself lives in the Keychain (secrets.js).
  asana: { workspace: null, postResults: true, logTime: false },
  schedule: { enabled: false, time: '08:30', days: [1, 2, 3, 4, 5], what: 'queued' },
};

function cleanAgency(a, i) {
  const out = { ...DEFAULT_AGENCY, ...a };
  out.id = slugify(out.id || out.label || `agency-${i + 1}`);
  out.label = String(out.label || out.id).slice(0, 60);
  out.color = /^#[0-9a-f]{6}$/i.test(out.color) ? out.color : DEFAULT_AGENCY.color;
  out.choices = out.choices === 'random' ? 'random' : 'first';
  for (const k of ['name', 'email', 'phone', 'company', 'subject', 'message']) out[k] = String(out[k] ?? '').slice(0, 2000);
  // Custom field rules: a field whose label/placeholder/name contains `match` gets `value`.
  out.rules = (Array.isArray(out.rules) ? out.rules : [])
    .map(r => ({ match: String(r?.match ?? '').trim().slice(0, 100), value: String(r?.value ?? '').slice(0, 1000) }))
    .filter(r => r.match);
  return out;
}

function cleanSchedule(sc) {
  const out = { ...DEFAULT_SETTINGS.schedule, ...(sc || {}) };
  out.enabled = !!out.enabled;
  out.time = /^([01]\d|2[0-3]):[0-5]\d$/.test(out.time) ? out.time : '08:30';
  out.days = [...new Set((Array.isArray(out.days) ? out.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  out.what = out.what === 'all' ? 'all' : 'queued';
  return out;
}

export function getSettings() {
  const s = readJson(F.settings, {});
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.schedule = cleanSchedule(s.schedule);
  out.asana = { ...DEFAULT_SETTINGS.asana, ...(s.asana || {}) };
  if (!['now', 'queue', 'off'].includes(out.formTestMode)) out.formTestMode = 'queue';
  out.agencies = (out.agencies?.length ? out.agencies : [DEFAULT_AGENCY]).map(cleanAgency);
  if (!out.agencies.some(a => a.id === out.defaultAgency)) out.defaultAgency = out.agencies[0].id;
  return out;
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  next.concurrency = Math.max(1, Math.min(10, parseInt(next.concurrency, 10) || 4));
  next.schedule = cleanSchedule(next.schedule);
  next.asana = { ...DEFAULT_SETTINGS.asana, ...(next.asana || {}) };
  if (!['now', 'queue', 'off'].includes(next.formTestMode)) next.formTestMode = 'queue';
  next.agencies = (next.agencies?.length ? next.agencies : [DEFAULT_AGENCY]).map(cleanAgency);
  const seen = new Set();
  for (const a of next.agencies) { while (seen.has(a.id)) a.id += '-2'; seen.add(a.id); }
  if (!next.agencies.some(a => a.id === next.defaultAgency)) next.defaultAgency = next.agencies[0].id;
  writeJson(F.settings, next);
  return next;
}

/** The agency whose details a site's form test fills in: its own, else the default. */
export function agencyFor(siteId) {
  const s = getSettings();
  const want = siteState(siteId).agencyId;
  return s.agencies.find(a => a.id === want) || s.agencies.find(a => a.id === s.defaultAgency) || s.agencies[0];
}

// ── Sites ────────────────────────────────────────────────────────────────────

export function slugify(s) {
  return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
}

function normUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }
function urlKey(u) { return normUrl(u).replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase(); }

export const SITES_DIR = process.env.CC_SITES_DIR || path.join(os.homedir(), 'claude-sites');
export const MCP_SITES_FILE = process.env.CC_MCP_SITES || path.join(ROOT, '..', 'mcp-server', 'sites.json');

// One-click installer workspaces: ~/claude-sites/<slug>/.mcp.json with WP_URL/WP_KEY env.
function fromClaudeSites() {
  const dir = SITES_DIR;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const cfg = readJson(path.join(dir, e.name, '.mcp.json'), null);
    const env = cfg?.mcpServers?.['claude-connector']?.env;
    if (!env?.WP_KEY || !(env.WP_URL || env.WP_RELAY_URL)) continue;
    out.push({
      name: e.name, url: normUrl(env.WP_URL), key: env.WP_KEY, mode: env.WP_MODE || 'rest',
      relayUrl: normUrl(env.WP_RELAY_URL), relayKey: env.WP_RELAY_KEY || '', source: 'claude-sites',
    });
  }
  return out;
}

function fromMcpSitesJson() {
  const list = readJson(MCP_SITES_FILE, []);
  return (Array.isArray(list) ? list : []).filter(s => s.key && s.url).map(s => ({
    name: s.name, url: normUrl(s.url), key: s.key, mode: s.mode || 'rest',
    relayUrl: normUrl(s.relayUrl), relayKey: s.relayKey || '', source: 'sites.json',
  }));
}

function manualFile() { return readJson(F.sites, { manual: [], hidden: [] }); }

/** All sites, deduped by URL. Hand-added entries win, then sites.json, then ~/claude-sites. */
export function listSites({ includeHidden = false } = {}) {
  const m = manualFile();
  const byUrl = new Map();
  for (const s of [...fromClaudeSites(), ...fromMcpSitesJson(), ...m.manual.map(s => ({ ...s, source: 'manual' }))]) {
    byUrl.set(urlKey(s.url || s.relayUrl), s);
  }
  const used = new Set();
  const sites = [];
  for (const s of byUrl.values()) {
    let id = slugify(s.name || s.url);
    while (used.has(id)) id += '-2';
    used.add(id);
    sites.push({ ...s, id, hidden: m.hidden.includes(urlKey(s.url)) });
  }
  sites.sort((a, b) => a.name.localeCompare(b.name));
  return includeHidden ? sites : sites.filter(s => !s.hidden);
}

export function getSite(id) {
  return listSites({ includeHidden: true }).find(s => s.id === id) || null;
}

export function addSite({ name, url, key, mode = 'rest', relayUrl = '', relayKey = '' }) {
  if (!url || !key) throw new Error('URL and API key are required.');
  const m = manualFile();
  url = normUrl(url);
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  m.manual = m.manual.filter(s => urlKey(s.url) !== urlKey(url));
  m.manual.push({ name: name || url.replace(/^https?:\/\//, ''), url, key, mode, relayUrl: normUrl(relayUrl), relayKey });
  m.hidden = m.hidden.filter(h => h !== urlKey(url));
  writeJson(F.sites, m);
}

/** Hand-added sites are removed; discovered ones are hidden (their config lives elsewhere). */
export function removeSite(id) {
  const site = getSite(id);
  if (!site) return;
  const m = manualFile();
  if (site.source === 'manual') m.manual = m.manual.filter(s => urlKey(s.url) !== urlKey(site.url));
  else if (!m.hidden.includes(urlKey(site.url))) m.hidden.push(urlKey(site.url));
  writeJson(F.sites, m);
}

export function unhideAll() {
  const m = manualFile();
  m.hidden = [];
  writeJson(F.sites, m);
}

// ── Cached state per site ────────────────────────────────────────────────────

let state = readJson(F.state, { sites: {} });

export function siteState(id) {
  return state.sites[id] || (state.sites[id] = {});
}

export function patchSiteState(id, patch) {
  Object.assign(siteState(id), patch);
  writeJson(F.state, state);
  return state.sites[id];
}

export function getMeta() { return state.meta || (state.meta = {}); }
export function patchMeta(patch) {
  Object.assign(getMeta(), patch);
  writeJson(F.state, state);
  return state.meta;
}

// ── History ──────────────────────────────────────────────────────────────────

let history = readJson(F.history, []);

export function addHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, 1000);
  writeJson(F.history, history);
}

export function getHistory({ site, limit = 50, since } = {}) {
  let list = site ? history.filter(h => h.site === site) : history;
  if (since) list = list.filter(h => h.at >= since);
  return list.slice(0, limit);
}

/** Each site's most recent run, if it failed and has not been dismissed. */
export function openFailures() {
  const ack = getMeta().failuresAckAt || '';
  const seen = new Set();
  const out = [];
  for (const h of history) {
    if (seen.has(h.site)) continue;
    seen.add(h.site);
    if (h.status === 'failed' && h.at > ack) out.push(h);
  }
  return out;
}
