// "Connect on this Mac": the WordPress settings page opens a claude-connector://
// link, the Site Maintenance app (shortcut.js) passes it here, and this sets the
// site up the way the Mac setup script does - shared MCP server in
// ~/claude-sites/.mcp-server, a workspace in ~/claude-sites/<slug> with .mcp.json
// and CLAUDE.md - then opens it in VS Code.
//
// The link only says where to fetch the site's details (with a single-use
// token). They are fetched once and shown for confirmation before anything is
// written, so a link from somewhere else cannot quietly add a site.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { SITES_DIR, slugify } from './store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MCP_DIR = path.join(SITES_DIR, '.mcp-server');
const REPO_RAW = 'https://raw.githubusercontent.com/wisnuub/claude-connector/main/mcp-server';
const MCP_FILES = ['index.js', 'knowledge.js', 'screenshot.js', 'package.json'];
const PENDING_TTL = 15 * 60_000;

const pending = new Map(); // id -> { details, endpointHost, expires }

/** Parses claude-connector://connect?endpoint=… into the https endpoint URL. */
function endpointFrom(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error('That is not a connect link.'); }
  if (u.protocol !== 'claude-connector:') throw new Error('That is not a claude-connector:// link.');
  let ep;
  try { ep = new URL(u.searchParams.get('endpoint') || ''); } catch { throw new Error('The connect link has no valid endpoint.'); }
  if (!['https:', 'http:'].includes(ep.protocol)) throw new Error('The connect link must point to an http(s) site.');
  if (ep.searchParams.get('action') !== 'claude_setup_json' || !ep.searchParams.get('t')) throw new Error('The connect link does not point to a Claude Connector site.');
  return ep;
}

/** Step 1: fetch the site's details (uses up the token) and hold them for confirmation. */
export async function previewConnect(link) {
  const ep = endpointFrom(link);
  const res = await fetch(ep, { headers: { Accept: 'application/json' } }).catch(e => { throw new Error(`Could not reach ${ep.host}: ${e.message}`); });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.data?.message || `The site answered HTTP ${res.status}.`);
  const d = body.data;
  if (!d?.url || !d?.key) throw new Error('The site sent incomplete details.');
  // The details must be for the site the link came from.
  const siteHost = new URL(d.url).host.replace(/^www\./, '');
  if (siteHost !== ep.host.replace(/^www\./, '')) throw new Error(`The link came from ${ep.host} but describes ${siteHost} - not connecting.`);

  const slug = freeSlug(slugify(d.slug || siteHost), d.url);
  const id = crypto.randomUUID();
  pending.set(id, { details: { ...d, slug }, expires: Date.now() + PENDING_TTL });
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  return {
    id, name: d.name, url: d.url, slug, pluginVersion: d.plugin_version || null,
    folder: path.join(SITES_DIR, slug),
    exists: fs.existsSync(path.join(SITES_DIR, slug, '.mcp.json')),
  };
}

/** The workspace folder for a site: its slug, or slug-2… if that folder belongs to another site. */
function freeSlug(slug, url) {
  for (let i = 1; ; i++) {
    const s = i === 1 ? slug : `${slug}-${i}`;
    const cfg = path.join(SITES_DIR, s, '.mcp.json');
    if (!fs.existsSync(cfg)) return s;
    try {
      const env = JSON.parse(fs.readFileSync(cfg, 'utf8'))?.mcpServers?.['claude-connector']?.env;
      if ((env?.WP_URL || '').replace(/\/+$/, '') === String(url).replace(/\/+$/, '')) return s; // same site: refresh it
    } catch {}
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `${cmd} exited with ${code}`))));
  });
}

// launchd / Finder start the app with a bare PATH; look next to this node first.
const PATH_PLUS = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':');

/** Refreshes the shared MCP server, as the setup script does on every run. */
async function ensureMcpServer() {
  fs.mkdirSync(MCP_DIR, { recursive: true });
  for (const f of MCP_FILES) {
    try {
      const r = await fetch(`${REPO_RAW}/${f}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(path.join(MCP_DIR, f), Buffer.from(await r.arrayBuffer()));
    } catch {
      // Offline or rate-limited: use this checkout's copy.
      fs.copyFileSync(path.join(ROOT, '..', 'mcp-server', f), path.join(MCP_DIR, f));
    }
  }
  await run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: MCP_DIR, env: { ...process.env, PATH: PATH_PLUS } });
}

async function openInVSCode(dir) {
  try { await run('code', [dir], { env: { ...process.env, PATH: PATH_PLUS } }); return true; } catch {}
  try { await run('open', ['-a', 'Visual Studio Code', dir]); return true; } catch {}
  return false;
}

/** Step 2: the user confirmed - write the workspace and open it. */
export async function confirmConnect(id, { openEditor = true } = {}) {
  const p = pending.get(id);
  if (!p || p.expires < Date.now()) throw new Error('This connect request has expired - click Connect on this Mac in WP Admin again.');
  pending.delete(id);
  const d = p.details;

  await ensureMcpServer();
  const dir = path.join(SITES_DIR, d.slug);
  fs.mkdirSync(dir, { recursive: true });
  // Same shape as the setup script writes.
  const mcp = { mcpServers: { 'claude-connector': { command: 'node', args: [path.join(MCP_DIR, 'index.js')], env: { WP_URL: d.url, WP_KEY: d.key, WP_MODE: d.mode || 'ajax' } } } };
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(mcp, null, 4));
  const md = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(md) && d.claude_md) fs.writeFileSync(md, d.claude_md); // keep a customised one

  const opened = openEditor ? await openInVSCode(dir) : false;
  return { slug: d.slug, name: d.name, url: d.url, folder: dir, opened };
}
