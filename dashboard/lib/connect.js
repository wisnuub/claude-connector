// "Connect on this Mac" / "Connect on this PC": the WordPress settings page makes a
// claude-connector:// link - on a Mac the Site Maintenance app (shortcut.js) opens
// it, on Windows WP Admin opens the dashboard's /#connect= directly - it is passed
// here, and this sets the
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
import { sitesDir, slugify } from './store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mcpDir = () => path.join(sitesDir(), '.mcp-server');
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
    folder: path.join(sitesDir(), slug),
    exists: fs.existsSync(path.join(sitesDir(), slug, '.mcp.json')),
  };
}

/** The workspace folder for a site: its slug, or slug-2… if that folder belongs to another site. */
function freeSlug(slug, url) {
  for (let i = 1; ; i++) {
    const s = i === 1 ? slug : `${slug}-${i}`;
    const cfg = path.join(sitesDir(), s, '.mcp.json');
    if (!fs.existsSync(cfg)) return s;
    try {
      const env = JSON.parse(fs.readFileSync(cfg, 'utf8').replace(/^\uFEFF/, ''))?.mcpServers?.['claude-connector']?.env;
      if ((env?.WP_URL || '').replace(/\/+$/, '') === String(url).replace(/\/+$/, '')) return s; // same site: refresh it
    } catch {}
  }
}

const WIN = process.platform === 'win32';
const winArg = a => (/[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // npm and code are .cmd files on Windows, which Node only starts through a shell.
    const p = WIN
      ? spawn([cmd, ...args.map(winArg)].join(' '), { stdio: ['ignore', 'pipe', 'pipe'], shell: true, ...opts })
      : spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `${cmd} exited with ${code}`))));
  });
}

// launchd / Finder start the app with a bare PATH; look next to this node first.
// Windows keeps the user's PATH (its key is "Path", and entries contain ':').
const RUN_ENV = WIN ? process.env : {
  ...process.env,
  PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'),
};

/** Refreshes the shared MCP server, as the setup script does on every run. */
async function ensureMcpServer() {
  fs.mkdirSync(mcpDir(), { recursive: true });
  for (const f of MCP_FILES) {
    try {
      const r = await fetch(`${REPO_RAW}/${f}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(path.join(mcpDir(), f), Buffer.from(await r.arrayBuffer()));
    } catch {
      // Offline or rate-limited: use this checkout's copy.
      fs.copyFileSync(path.join(ROOT, '..', 'mcp-server', f), path.join(mcpDir(), f));
    }
  }
  await run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: mcpDir(), env: RUN_ENV });
}

/** Opens a folder (and optionally a file in it) in VS Code. */
export async function openInVSCode(dir, file = null) {
  const args = file ? [dir, file] : [dir];
  try { await run('code', args, { env: RUN_ENV }); return true; } catch {}
  if (!WIN) try { await run('open', ['-a', 'Visual Studio Code', ...args]); return true; } catch {}
  return false;
}

/** Writes a site's workspace: .mcp.json (same shape as the setup script) and, if missing, CLAUDE.md. */
async function writeWorkspace(dir, { url, key, mode, relayUrl, relayKey }, claudeMd) {
  await ensureMcpServer();
  fs.mkdirSync(dir, { recursive: true });
  const env = { WP_URL: url, WP_KEY: key, WP_MODE: mode || 'ajax' };
  if (relayUrl && relayKey) Object.assign(env, { WP_RELAY_URL: relayUrl, WP_RELAY_KEY: relayKey });
  const mcp = { mcpServers: { 'claude-connector': { command: 'node', args: [path.join(mcpDir(), 'index.js')], env } } };
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(mcp, null, 4));
  const md = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(md) && claudeMd) fs.writeFileSync(md, claudeMd); // keep a customised one
}

/**
 * The Claude Code workspace for a dashboard site: its ~/claude-sites folder, or a
 * new one for sites added by hand or from sites.json.
 */
export async function ensureWorkspace(site) {
  if (site.source === 'claude-sites') {
    const dir = path.join(sitesDir(), site.name);
    if (fs.existsSync(path.join(dir, '.mcp.json'))) return dir;
  }
  const dir = path.join(sitesDir(), freeSlug(slugify(site.name), site.url));
  if (!fs.existsSync(path.join(dir, '.mcp.json'))) {
    await writeWorkspace(dir, site, `# ${site.name}\n\nWordPress site ${site.url}, connected through the Claude Connector MCP tools.\n`);
  }
  return dir;
}

/** Step 2: the user confirmed - write the workspace and open it. */
export async function confirmConnect(id, { openEditor = true } = {}) {
  const p = pending.get(id);
  if (!p || p.expires < Date.now()) throw new Error('This connect request has expired - click Connect in WP Admin again.');
  pending.delete(id);
  const d = p.details;

  const dir = path.join(sitesDir(), d.slug);
  await writeWorkspace(dir, { url: d.url, key: d.key, mode: d.mode }, d.claude_md);

  const opened = openEditor ? await openInVSCode(dir) : false;
  return { slug: d.slug, name: d.name, url: d.url, folder: dir, opened };
}
