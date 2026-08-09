#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// ── Site configuration ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_FILE = path.join(__dirname, 'sites.json');

let sites = [];
try { sites = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); } catch {}

// Fall back to env vars for single-site backward compat
if (!sites.length) {
  const WP_URL    = (process.env.WP_URL    || '').replace(/\/$/, '');
  const WP_KEY    = process.env.WP_KEY    || '';
  const RELAY_URL = (process.env.WP_RELAY_URL || '').replace(/\/$/, '');
  const RELAY_KEY = process.env.WP_RELAY_KEY || '';
  if (WP_KEY && (WP_URL || RELAY_URL)) {
    sites = [{ name: 'default', url: WP_URL, key: WP_KEY, relayUrl: RELAY_URL, relayKey: RELAY_KEY,
               mode: process.env.WP_MODE || 'rest' }];
  }
}

if (!sites.length) {
  process.stderr.write('claude-connector-mcp: no sites configured. Run: node mcp-server/setup.js\n');
  process.exit(1);
}

function getSite(name) {
  if (!name) return sites[0];
  return sites.find(s => s.name === name) ?? sites[0];
}

const NS = 'claude/v1';
const CHUNK = 50 * 1024;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function directCall(site, method, endpoint, params = null, body = null) {
  let url = `${site.url}/wp-json/${NS}${endpoint}`;
  if (params && Object.keys(params).length) url += '?' + new URLSearchParams(params).toString();
  const opts = { method, headers: { 'X-Claude-Key': site.key, 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function relayCall(site, method, endpoint, params = null, body = null) {
  const pushRes = await fetch(`${site.relayUrl}/push`, {
    method: 'POST',
    headers: { 'X-Relay-Key': site.relayKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, endpoint, params: params || {}, body }),
  });
  if (!pushRes.ok) throw new Error(`Relay push failed: ${pushRes.status}`);
  const { id } = await pushRes.json();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`${site.relayUrl}/result/${id}`, { headers: { 'X-Relay-Key': site.relayKey } });
    if (res.status === 200) {
      const result = await res.json();
      if (result.status >= 400) throw new Error(`WP ${result.status}: ${JSON.stringify(result.body)}`);
      return result.body;
    }
  }
  throw new Error('Relay timeout: no result after 30 s');
}

async function ajaxCall(site, method, endpoint, params = null, body = null) {
  const url = `${site.url}/wp-admin/admin-ajax.php?action=claude_cmd`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Claude-Key': site.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, endpoint, params: params || {}, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Admin AJAX ${res.status}: ${JSON.stringify(data)}`);
  if (data.status >= 400) throw new Error(`WP ${data.status}: ${JSON.stringify(data.body)}`);
  return data.body;
}

// ── Encrypted mode (AES-256-GCM) ─────────────────────────────────────────────
//
// Derives a 32-byte AES key from the API key (SHA-256), then encrypts the
// command JSON so the WAF only ever sees opaque base64.  No X-Claude-Key
// header is sent — the correct key is proved by successful decryption on the
// WordPress side.
//
// Wire format: base64( IV[12] + GCM_ciphertext_with_tag_appended[n+16] )
// This matches exactly what PHP's openssl_decrypt expects when given the tag
// as the last 16 bytes of the ciphertext (WebCrypto AES-GCM layout).

async function encryptPayload(plaintext, apiKey) {
  const enc       = new TextEncoder();
  const keyDigest = await crypto.subtle.digest('SHA-256', enc.encode(apiKey));
  const aesKey    = await crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const cipher    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext));
  // Combine IV + ciphertext (tag is already appended by WebCrypto)
  const combined  = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(cipher), 12);
  return Buffer.from(combined).toString('base64');
}

async function encCall(site, method, endpoint, params = null, body = null) {
  const payload = JSON.stringify({ method, endpoint, params: params || {}, body });
  const enc     = await encryptPayload(payload, site.key);
  const url     = `${site.url}/wp-admin/admin-ajax.php?action=claude_enc`;
  const res     = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ enc }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Encrypted AJAX ${res.status}: ${JSON.stringify(data)}`);
  if (data.status >= 400) throw new Error(`WP ${data.status}: ${JSON.stringify(data.body)}`);
  return data.body;
}

function api(method, endpoint, params = null, body = null, siteName = null) {
  const site = getSite(siteName);
  if (site.mode === 'enc')  return encCall(site, method, endpoint, params, body);
  if (site.mode === 'ajax') return ajaxCall(site, method, endpoint, params, body);
  const useRelay = !!(site.relayUrl && site.relayKey);
  return useRelay
    ? relayCall(site, method, endpoint, params, body)
    : directCall(site, method, endpoint, params, body);
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function safeCall(fn) {
  try { return await fn(); }
  catch (err) { return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }; }
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'claude-connector', version: '1.5.0' });

const S = z.string().optional().describe(
  `Site name - one of: ${sites.map(s => s.name).join(', ')} (default: ${sites[0].name})`
);

// Sites meta-tool
server.tool('wp_sites_list',
  'List all configured WordPress sites by name and URL',
  {},
  () => ok(sites.map(s => ({ name: s.name, url: s.url })))
);

// Status
server.tool('wp_status',
  'Get WordPress site info: WP/PHP version, active theme, active plugins, URLs',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/status', null, null, site)))
);

// Posts - list
server.tool('wp_posts_list', 'Query WordPress posts/pages/CPTs', {
  site:     S,
  type:     z.string().optional().describe('Post type, e.g. post, page (default: post)'),
  status:   z.string().optional().describe('Status filter: publish, draft, any, etc.'),
  per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100)'),
  page:     z.number().int().min(1).optional().describe('Page number'),
  search:   z.string().optional().describe('Full-text search term'),
  orderby:  z.string().optional().describe('Sort field (date, title, ID, menu_order, etc.)'),
  order:    z.enum(['ASC', 'DESC']).optional(),
}, ({ site, type, status, per_page, page, search, orderby, order }) =>
  safeCall(async () => {
    const params = {};
    if (type)     params.type     = type;
    if (status)   params.status   = status;
    if (per_page) params.per_page = per_page;
    if (page)     params.page     = page;
    if (search)   params.s        = search;
    if (orderby)  params.orderby  = orderby;
    if (order)    params.order    = order;
    return ok(await api('GET', '/posts', params, null, site));
  })
);

// Posts - get single
server.tool('wp_posts_get',
  'Get a single WordPress post with all meta fields and taxonomy terms',
  { site: S, id: z.number().int().describe('Post ID') },
  ({ site, id }) => safeCall(async () => ok(await api('GET', `/posts/${id}`, null, null, site)))
);

// Posts - create
server.tool('wp_posts_create', 'Create a new WordPress post, page, or custom post type', {
  site:          S,
  post_title:    z.string().optional(),
  post_content:  z.string().optional(),
  post_excerpt:  z.string().optional(),
  post_status:   z.string().optional().describe('publish, draft, private, pending, etc.'),
  post_type:     z.string().optional().describe('post, page, or any registered CPT'),
  post_name:     z.string().optional().describe('URL slug'),
  post_author:   z.number().int().optional(),
  menu_order:    z.number().int().optional(),
  post_parent:   z.number().int().optional(),
  page_template: z.string().optional(),
  meta_input:    z.record(z.any()).optional().describe('Post meta as key-value pairs'),
}, ({ site, ...body }) => safeCall(async () => ok(await api('POST', '/posts', null, body, site)))
);

// Posts - update
server.tool('wp_posts_update', 'Update an existing WordPress post or page', {
  site:          S,
  id:            z.number().int().describe('Post ID to update'),
  post_title:    z.string().optional(),
  post_content:  z.string().optional(),
  post_excerpt:  z.string().optional(),
  post_status:   z.string().optional(),
  post_name:     z.string().optional(),
  menu_order:    z.number().int().optional(),
  page_template: z.string().optional(),
  meta_input:    z.record(z.any()).optional(),
}, ({ site, id, ...fields }) => safeCall(async () => ok(await api('PUT', `/posts/${id}`, null, fields, site)))
);

// Posts - delete
server.tool('wp_posts_delete', 'Delete a WordPress post (sends to trash by default)', {
  site:  S,
  id:    z.number().int().describe('Post ID'),
  force: z.boolean().optional().describe('Skip trash, permanently delete (default: false)'),
}, ({ site, id, force }) =>
  safeCall(async () => ok(await api('DELETE', `/posts/${id}`, force ? { force: '1' } : null, null, site)))
);

// Options - get
server.tool('wp_options_get', 'Read a WordPress option from wp_options', {
  site: S,
  key:  z.string().describe('Option name, e.g. blogname, siteurl'),
}, ({ site, key }) => safeCall(async () => ok(await api('GET', '/options', { key }, null, site)))
);

// Options - set
server.tool('wp_options_set', 'Write a WordPress option (protected core keys are blocked)', {
  site:  S,
  key:   z.string().describe('Option name'),
  value: z.any().describe('Option value (string, number, array, or object)'),
}, ({ site, key, value }) => safeCall(async () => ok(await api('POST', '/options', null, { key, value }, site)))
);

// Plugins - list
server.tool('wp_plugins_list',
  'List all installed WordPress plugins with their active/inactive status',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/plugins', null, null, site)))
);

// Plugins - manage
server.tool('wp_plugins_manage', 'Activate or deactivate a WordPress plugin', {
  site:   S,
  plugin: z.string().describe('Plugin file path, e.g. akismet/akismet.php'),
  action: z.enum(['activate', 'deactivate']),
}, ({ site, plugin, action }) =>
  safeCall(async () => ok(await api('POST', '/plugins', null, { plugin, action }, site)))
);

// Themes - list
server.tool('wp_themes_list',
  'List all installed WordPress themes',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/themes', null, null, site)))
);

// Themes - switch
server.tool('wp_themes_switch', 'Switch the active WordPress theme', {
  site:       S,
  stylesheet: z.string().describe('Theme stylesheet slug, e.g. twentytwentyfour'),
}, ({ site, stylesheet }) =>
  safeCall(async () => ok(await api('POST', '/themes', null, { stylesheet }, site)))
);

// Files - list
server.tool('wp_files_list', 'List files in a wp-content subdirectory', {
  site: S,
  path: z.string().describe('Path relative to wp-content, e.g. themes/mytheme'),
}, ({ site, path }) => safeCall(async () => ok(await api('GET', '/files', { path }, null, site)))
);

// Files - read
server.tool('wp_files_read', "Read a file's content from within wp-content", {
  site: S,
  path: z.string().describe('Path relative to wp-content, e.g. themes/mytheme/functions.php'),
}, ({ site, path }) => safeCall(async () => ok(await api('GET', '/files/read', { path }, null, site)))
);

// Files - write (auto-chunks large files to bypass WAF limits)
server.tool('wp_files_write', 'Write or overwrite a file in wp-content (auto-chunks large files)', {
  site:    S,
  path:    z.string().describe('Path relative to wp-content'),
  content: z.string().describe('Full file content to write'),
}, ({ site, path, content }) =>
  safeCall(async () => {
    const b64 = Buffer.from(content).toString('base64');
    if (b64.length <= CHUNK) {
      return ok(await api('POST', '/files', null, { path, content_b64: b64 }, site));
    }
    const chunks = [];
    for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
    for (let i = 0; i < chunks.length; i++) {
      await api('POST', '/files/stage', null, {
        path, content_b64: chunks[i], chunk_index: i, chunk_total: chunks.length,
      }, site);
    }
    return ok(await api('POST', '/files/commit', null, { path, chunk_total: chunks.length }, site));
  })
);

// Files - delete
server.tool('wp_files_delete', 'Delete a file or empty directory from wp-content', {
  site: S,
  path: z.string().describe('Path relative to wp-content'),
}, ({ site, path }) => safeCall(async () => ok(await api('DELETE', '/files', { path }, null, site)))
);

// DB - tables
server.tool('wp_db_tables',
  'List all WordPress database tables',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/db/tables', null, null, site)))
);

// DB - query
server.tool('wp_db_query', 'Execute a raw SQL query against the WordPress database', {
  site:  S,
  query: z.string().describe('SQL query to run'),
  type:  z.enum(['get_results', 'get_row', 'get_var', 'get_col', 'query'])
          .optional()
          .default('get_results')
          .describe('get_results=all rows, get_row=one row, get_var=scalar, query=INSERT/UPDATE/DELETE'),
}, ({ site, query, type }) =>
  safeCall(async () => ok(await api('POST', '/db/query', null, { query, type }, site)))
);

// Cache - purge
server.tool('wp_cache_purge',
  'Flush all WordPress caches (object cache, transients, WP Engine, W3TC, WP Rocket, LiteSpeed)',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('POST', '/cache/purge', null, null, site)))
);

// ACF/SCF - list groups
server.tool('wp_acf_groups',
  'List ACF/SCF field groups and their sync status (requires ACF or Secure Custom Fields plugin)',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/acf/groups', null, null, site)))
);

// ACF/SCF - export field group with all fields
server.tool('wp_acf_group_export',
  'Export an ACF/SCF field group (with all fields) as JSON — useful for inspecting schema or backing up before changes',
  {
    site: S,
    key:  z.string().describe('Field group key, e.g. group_6123abc'),
  },
  ({ site, key }) => safeCall(async () => ok(await api('GET', `/acf/groups/${key}/export`, null, null, site)))
);

// ACF/SCF - read field values for a post
server.tool('wp_acf_fields_get',
  'Read all ACF/SCF field values for a post (any post type). Returns field names and their values.',
  {
    site:         S,
    id:           z.number().int().describe('Post ID'),
    format_value: z.boolean().optional().describe('Return formatted values (default: true). Pass false for raw DB values.'),
  },
  ({ site, id, format_value }) => safeCall(async () => {
    const params = format_value === false ? { format_value: 'false' } : null;
    return ok(await api('GET', `/acf/fields/${id}`, params, null, site));
  })
);

// ACF/SCF - write field values for a post
server.tool('wp_acf_fields_set',
  'Write ACF/SCF field values for a post. Supports all field types including repeater and flexible content.',
  {
    site:   S,
    id:     z.number().int().describe('Post ID'),
    fields: z.record(z.any()).describe('Object of field_name (or field_key): value pairs, e.g. {"hero_title": "Hello", "field_abc123": "world"}'),
  },
  ({ site, id, fields }) => safeCall(async () => ok(await api('POST', `/acf/fields/${id}`, null, { fields }, site)))
);

// ACF/SCF - read options page fields
server.tool('wp_acf_options_get',
  'Read all ACF/SCF Options Page field values (requires an options page registered with acf_add_options_page)',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/acf/options', null, null, site)))
);

// ACF/SCF - write options page fields
server.tool('wp_acf_options_set',
  'Write ACF/SCF Options Page field values',
  {
    site:   S,
    fields: z.record(z.any()).describe('Object of field_name: value pairs for the ACF options page'),
  },
  ({ site, fields }) => safeCall(async () => ok(await api('POST', '/acf/options', null, { fields }, site)))
);

// Logs
server.tool('wp_logs_list', 'View recent Claude Connector API access log entries', {
  site:  S,
  limit: z.number().int().min(1).max(500).optional().describe('Number of entries (default 50)'),
}, ({ site, limit }) =>
  safeCall(async () => ok(await api('GET', '/logs', limit ? { limit } : null, null, site)))
);

// WP-CLI
server.tool('wp_wpcli', 'Run a WP-CLI command on the WordPress site via the plugin REST API', {
  site:    S,
  args:    z.array(z.string()).optional().describe('Command args e.g. ["plugin","list","--format=json"]'),
  command: z.string().optional().describe('Command string e.g. "plugin list --format=json" or "wp option get siteurl"'),
}, ({ site, args, command }) =>
  safeCall(async () => {
    if (!args && !command) throw new Error('Provide args (array) or command (string)');
    return ok(await api('POST', '/wpcli', null, args ? { args } : { command }, site));
  })
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
