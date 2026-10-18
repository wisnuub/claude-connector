// Calls a site's Claude Connector API over whichever transport the site uses -
// the same four the MCP server speaks (direct REST, admin-ajax, encrypted
// admin-ajax, Cloudflare relay). Keys stay in this process; the browser UI
// never sees them.

const NS = 'claude/v1';

export class WPError extends Error {
  constructor(status, body) {
    const msg = (body && body.message) || (typeof body === 'string' ? body.slice(0, 300) : `HTTP ${status}`);
    super(msg);
    this.status = status;
    this.code = (body && body.code) || `http_${status}`;
    this.data = (body && body.data) || null;
  }
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Timed out after ${Math.round(ms / 1000)} s`)), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ?rest_route= works whatever the permalink setting; /wp-json/ needs pretty permalinks.
async function directCall(site, method, endpoint, params, body, timeout) {
  const q = new URLSearchParams({ rest_route: `/${NS}${endpoint}`, ...(params || {}) });
  const t = withTimeout(timeout);
  try {
    const res = await fetch(`${site.url}/?${q}`, {
      method,
      headers: { 'X-Claude-Key': site.key, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: t.signal,
    });
    const data = await readJson(res);
    if (!res.ok) throw new WPError(res.status, data);
    return data;
  } finally { t.done(); }
}

async function ajaxCall(site, method, endpoint, params, body, timeout) {
  const t = withTimeout(timeout);
  try {
    const res = await fetch(`${site.url}/wp-admin/admin-ajax.php?action=claude_cmd`, {
      method: 'POST',
      headers: { 'X-Claude-Key': site.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, endpoint, params: params || {}, body }),
      signal: t.signal,
    });
    const data = await readJson(res);
    if (!res.ok) throw new WPError(res.status, data);
    if (data && data.status >= 400) throw new WPError(data.status, data.body);
    return data.body;
  } finally { t.done(); }
}

// AES-256-GCM, key = SHA-256(api key). Same wire format as mcp-server/index.js.
async function encrypt(plaintext, apiKey) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(apiKey));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), 12);
  return Buffer.from(out).toString('base64');
}

async function encCall(site, method, endpoint, params, body, timeout) {
  const payload = await encrypt(JSON.stringify({ method, endpoint, params: params || {}, body }), site.key);
  const t = withTimeout(timeout);
  try {
    const res = await fetch(`${site.url}/wp-admin/admin-ajax.php?action=claude_enc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enc: payload }),
      signal: t.signal,
    });
    const data = await readJson(res);
    if (!res.ok) throw new WPError(res.status, data);
    if (data && data.status >= 400) throw new WPError(data.status, data.body);
    return data.body;
  } finally { t.done(); }
}

async function relayCall(site, method, endpoint, params, body, timeout) {
  const push = await fetch(`${site.relayUrl}/push`, {
    method: 'POST',
    headers: { 'X-Relay-Key': site.relayKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, endpoint, params: params || {}, body }),
  });
  if (!push.ok) throw new WPError(push.status, `Relay push failed: ${push.status}`);
  const { id } = await push.json();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`${site.relayUrl}/result/${id}`, { headers: { 'X-Relay-Key': site.relayKey } });
    if (res.status === 200) {
      const result = await res.json();
      if (result.status >= 400) throw new WPError(result.status, result.body);
      return result.body;
    }
  }
  throw new WPError(504, `Relay timeout: no result after ${Math.round(timeout / 1000)} s`);
}

/**
 * @param {object} site  { url, key, mode?, relayUrl?, relayKey? }
 * @param {object} [o]   { params, body, timeout (ms) }
 */
export function call(site, method, endpoint, { params = null, body = null, timeout = 60_000 } = {}) {
  if (site.mode === 'enc') return encCall(site, method, endpoint, params, body, timeout);
  if (site.mode === 'ajax') return ajaxCall(site, method, endpoint, params, body, timeout);
  if (site.relayUrl && site.relayKey) return relayCall(site, method, endpoint, params, body, timeout);
  return directCall(site, method, endpoint, params, body, timeout);
}

// Updates download and unpack on the server; core can take a minute or more.
export const LONG = 360_000;

/**
 * Loads the homepage from outside, the way a visitor would - catches what the
 * plugin's own loopback check cannot see (host error pages, a CDN in front).
 */
export async function externalCheck(url) {
  const t = withTimeout(30_000);
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: t.signal, headers: { 'User-Agent': 'ClaudeConnectorDashboard/1.8 (+maintenance check)', 'Cache-Control': 'no-cache' } });
    const text = await res.text();
    const ms = Date.now() - started;
    const critical = /There has been a critical error on this website|Fatal error<\/b>:|Briefly unavailable for scheduled maintenance|Error establishing a database connection/i.exec(text);
    if (critical) return { status: 'fatal', code: res.status, ms, message: `Homepage shows: "${critical[0].replace(/<[^>]+>/g, '')}"` };
    if (res.status >= 500) return { status: 'fatal', code: res.status, ms, message: `Homepage returned HTTP ${res.status}` };
    if (res.status >= 400) return { status: 'warning', code: res.status, ms, message: `Homepage returned HTTP ${res.status}` };
    return { status: 'ok', code: res.status, ms };
  } catch (e) {
    return { status: 'fatal', code: 0, ms: Date.now() - started, message: `Homepage did not load: ${e.message}` };
  } finally { t.done(); }
}
