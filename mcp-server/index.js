#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { searchKnowledge, addKnowledge } from './knowledge.js';

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

// Kept in step with CLAUDE_CONNECTOR_VERSION in claude-connector.php. The two
// halves ship together, and a stale copy of this file silently hides whole
// tools - which is much harder to notice than an outright error.
const MCP_VERSION = '1.6.0';

const server = new McpServer({ name: 'claude-connector', version: MCP_VERSION });

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
  'Get WordPress site info: WP/PHP version, active theme, active plugins, URLs, which user the connector '
  + 'acts as (check acting_as.unfiltered_html - if false, builder content will be corrupted on write), '
  + 'detected page builder, and whether this MCP server matches the installed plugin version.',
  { site: S },
  ({ site }) => safeCall(async () => {
    const data = await api('GET', '/status', null, null, site);
    return ok({ ...data, mcp_server_version: MCP_VERSION, version_check: versionNote(data) });
  })
);

/**
 * Compare this file's version against the installed plugin's.
 *
 * Version skew is a silent failure: an out-of-date copy of this file simply
 * doesn't register the newer tools, so they look like they don't exist rather
 * than like something is misconfigured.
 */
function versionNote(status) {
  const plugin = status?.plugin_version;
  if (!plugin) return 'Plugin version not reported; cannot verify.';
  if (plugin === MCP_VERSION) return `ok (both ${MCP_VERSION})`;

  const older = compareSemver(MCP_VERSION, plugin) < 0 ? 'MCP server' : 'plugin';
  return `MISMATCH: MCP server ${MCP_VERSION}, plugin ${plugin}. `
       + `The ${older} is older, so some tools or endpoints will be missing. `
       + `Update it (MCP server path: ${__dirname}).`;
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Warn once at startup too, so skew surfaces without anyone thinking to ask.
(async () => {
  try {
    const status = await api('GET', '/status', null, null, sites[0].name);
    if (status?.plugin_version && status.plugin_version !== MCP_VERSION) {
      process.stderr.write('claude-connector-mcp: ' + versionNote(status) + '\n');
    }
    if (status?.acting_as && status.acting_as.unfiltered_html === false) {
      process.stderr.write(
        'claude-connector-mcp: WARNING - the connector is acting as a user without the '
        + 'unfiltered_html capability. Gutenberg/Divi block delimiters will be HTML-escaped '
        + 'on write and layouts will be destroyed. Check Settings > Claude Connector.\n'
      );
    }
  } catch {
    // Never block startup on a reachability problem; the tools report their own errors.
  }
})();

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
server.tool('wp_posts_update',
  'Update an existing WordPress post or page. For Divi builder content prefer wp_divi_data_set, which '
  + 'also applies the builder postmeta and flushes Divi\'s CSS cache. Block content is validated after '
  + 'the write and the response gains a "blocks" report - check blocks.valid.',
  {
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
server.tool('wp_options_get',
  'Read a WordPress option from wp_options. Supports DOTTED PATHS into serialised arrays, which is how '
  + 'themes store most of their settings - e.g. "et_divi.divi_integration_head" reads Divi\'s Integration '
  + '> Head field directly instead of returning the whole 12KB et_divi blob. A flat read of a nested key '
  + 'returns false, which is easy to misread as "not set".',
  {
    site: S,
    key:  z.string().describe('Option name, or a dotted path e.g. et_divi.divi_integration_head'),
  },
  ({ site, key }) => safeCall(async () => ok(await api('GET', '/options', { key }, null, site)))
);

// Options - set
server.tool('wp_options_set',
  'Write a WordPress option (protected core keys are blocked). Supports DOTTED PATHS, which patch a single '
  + 'value inside a serialised array and leave the rest of it untouched - use this rather than reading a '
  + 'whole theme options array, editing it and writing it back.',
  {
    site:  S,
    key:   z.string().describe('Option name, or a dotted path e.g. et_divi.divi_integration_head'),
    value: z.any().describe('Option value (string, number, array, or object)'),
  },
  ({ site, key, value }) => safeCall(async () => ok(await api('POST', '/options', null, { key, value }, site)))
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

// Files - fetch server-side (no bytes through the conversation)
server.tool('wp_files_fetch',
  'Have the SERVER download a URL straight into wp-content. Strongly prefer this over wp_files_write '
  + 'whenever the content already exists at a URL: wp_files_write sends every byte through the '
  + 'conversation, which for generated page markup means transmitting it twice (once to read it, once to '
  + 'write it). Returns a sha256 so you can confirm the transfer without reading the file back. '
  + 'Runs the same PHP syntax check as wp_files_write.',
  {
    site:      S,
    url:       z.string().describe('Source URL to download'),
    path:      z.string().describe('Destination path relative to wp-content'),
    timeout:   z.number().int().optional().describe('Seconds (default 60)'),
    max_bytes: z.number().int().optional().describe('Reject downloads larger than this (default 20MB)'),
  },
  ({ site, url, path, timeout, max_bytes }) => safeCall(async () =>
    ok(await api('POST', '/files/fetch', null, { url, path, timeout, max_bytes }, site)))
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
server.tool('wp_db_query',
  'Execute a raw SQL query against the WordPress database. '
  + 'Use "params" with %s/%d/%f placeholders rather than escaping by hand - builder content stores JSON '
  + 'inside post_content, so the column contains backslash-escaped quotes and hand-escaping them through '
  + 'JSON needs three levels of backslashes; getting it wrong silently matches nothing. '
  + 'For writes (type=query) the response includes changed_rows, which is what tells you a REPLACE() '
  + 'actually found its needle rather than just matching a row. Use dry_run to rehearse first. '
  + 'NOTE: raw SQL bypasses every WordPress hook, so after editing post_content on a Divi site you must '
  + 'run wp_divi_resave or the page keeps serving stale CSS.',
  {
    site:    S,
    query:   z.string().describe('SQL query, optionally with %s/%d/%f placeholders'),
    params:  z.array(z.union([z.string(), z.number()])).optional()
              .describe('Values bound to the placeholders via $wpdb->prepare()'),
    type:    z.enum(['get_results', 'get_row', 'get_var', 'get_col', 'query'])
              .optional()
              .default('get_results')
              .describe('get_results=all rows, get_row=one row, get_var=scalar, query=INSERT/UPDATE/DELETE'),
    dry_run: z.boolean().optional()
              .describe('type=query only: run inside a transaction, report changed_rows, then roll back (InnoDB)'),
    readonly: z.boolean().optional().describe('Reject anything that is not a plain SELECT'),
    confirm_destructive: z.boolean().optional()
              .describe('Required for DROP / TRUNCATE / DELETE without WHERE'),
  },
  ({ site, query, params, type, dry_run, readonly, confirm_destructive }) =>
    safeCall(async () => ok(await api('POST', '/db/query', null,
      { query, params, type, dry_run, readonly, confirm_destructive }, site)))
);

// Cache - purge
server.tool('wp_cache_purge',
  'Flush WordPress caches (object cache, transients, WP Engine, W3TC, WP Rocket, LiteSpeed). '
  + 'Pass builder:true to ALSO clear Divi\'s per-post CSS cache (wp-content/et-cache and the '
  + '_divi_dynamic_assets_cached_* postmeta) and Elementor\'s generated CSS - these live outside the '
  + 'object cache and are NOT invalidated by a raw SQL write, so without it the page serves stale styles '
  + 'and it looks like your edit did nothing. '
  + 'Pass resave_builder_posts:true after a plugin install/update to also force Divi to regenerate its '
  + 'per-module CSS (clearing alone can leave indices that do not match the markup).',
  {
    site:                 S,
    builder:              z.boolean().optional().describe('Also clear Divi/Elementor generated CSS caches'),
    resave_builder_posts: z.boolean().optional().describe('Also re-save every builder post to force clean CSS regeneration'),
  },
  ({ site, builder, resave_builder_posts }) => safeCall(async () =>
    ok(await api('POST', '/cache/purge', null, { builder, resave_builder_posts }, site)))
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

// Elementor - discover widget types + settings schema
server.tool('wp_elementor_widgets_list',
  'List registered Elementor widget types and their editable settings schema (requires Elementor)',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/elementor/widgets', null, null, site)))
);

// Elementor - read post's element tree
server.tool('wp_elementor_data_get',
  "Read a post's Elementor elements tree (_elementor_data) plus edit-mode/version meta",
  { site: S, id: z.number().int().describe('Post ID') },
  ({ site, id }) => safeCall(async () => ok(await api('GET', `/elementor/data/${id}`, null, null, site)))
);

// Elementor - write post's element tree
server.tool('wp_elementor_data_set',
  'Write an Elementor elements tree to a post, using real widget/control names from wp_elementor_widgets_list',
  {
    site:     S,
    id:       z.number().int().describe('Post ID'),
    elements: z.array(z.any()).describe('Elementor elements tree, e.g. [{ id, elType, widgetType?, settings, elements }]'),
  },
  ({ site, id, elements }) => safeCall(async () => ok(await api('POST', `/elementor/data/${id}`, null, { elements }, site)))
);

// Divi - discover module types
server.tool('wp_divi_modules_list',
  'List known Divi module types for this site (requires Divi). Dynamic schema discovery is best-effort for Divi 5.',
  { site: S },
  ({ site }) => safeCall(async () => ok(await api('GET', '/divi/modules', null, null, site)))
);

// Divi - read post's builder content
server.tool('wp_divi_data_get',
  "Read a post's Divi builder content (post_content) plus builder meta and detected generation (d4_shortcode or d5_json)",
  { site: S, id: z.number().int().describe('Post ID') },
  ({ site, id }) => safeCall(async () => ok(await api('GET', `/divi/data/${id}`, null, null, site)))
);

// Divi - write post's builder content
server.tool('wp_divi_data_set',
  'Write Divi builder content for a post - shortcode markup for classic Divi, module JSON for Divi 5. '
  + 'Check wp_divi_data_get\'s "generation" field first. Prefer this over wp_posts_update for builder '
  + 'content: it applies the full builder postmeta set (a Divi 5 page needs five meta rows or it renders '
  + 'on the theme default template with a widget sidebar), validates the block markup, and flushes Divi\'s '
  + 'per-post CSS cache. The response includes a "blocks" report - check blocks.valid.',
  {
    site:             S,
    id:               z.number().int().describe('Post ID'),
    content:          z.string().describe('Builder markup matching this site\'s detected Divi generation'),
    force_meta:       z.boolean().optional().describe('Overwrite existing layout meta (page_layout, side_nav) instead of only filling gaps'),
    skip_cache_flush: z.boolean().optional().describe('Skip the Divi per-post CSS cache flush (default false)'),
  },
  ({ site, id, content, force_meta, skip_cache_flush }) => safeCall(async () =>
    ok(await api('POST', `/divi/data/${id}`, null, { content, force_meta, skip_cache_flush }, site)))
);

// Divi - health audit
server.tool('wp_divi_audit',
  'Audit every Divi builder page for the two failure modes that are invisible from the database: '
  + '(1) builder content whose postmeta is missing, so the page renders on the theme default template '
  + 'with a widget sidebar and a duplicated title; (2) Divi\'s generated per-module CSS not matching the '
  + 'rendered markup, which happens after a plugin install/update invalidates Divi\'s caches and makes ALL '
  + 'attribute styling stop applying sitewide. Run this after installing or updating any plugin on a Divi '
  + 'site, and after editing post_content with raw SQL. Remedy for anything it finds is wp_divi_resave.',
  {
    site:       S,
    css_sample: z.number().int().min(0).max(25).optional().describe('How many pages to CSS-index check (default 5, each is one page fetch)'),
  },
  ({ site, css_sample }) => safeCall(async () =>
    ok(await api('GET', '/divi/audit', css_sample !== undefined ? { css_sample } : null, null, site)))
);

// Divi - re-save to regenerate CSS
server.tool('wp_divi_resave',
  'Re-save Divi builder posts so Divi regenerates their CSS cleanly. This is the standing remedy for the '
  + 'module-index mismatch wp_divi_audit detects, and the REQUIRED follow-up after editing post_content '
  + 'with raw SQL (SQL bypasses every WordPress hook, so Divi never learns the content changed and keeps '
  + 'serving stale CSS). Omit ids to re-save every builder post.',
  {
    site: S,
    ids:  z.array(z.number().int()).optional().describe('Specific post IDs. Omit to re-save all builder posts.'),
  },
  ({ site, ids }) => safeCall(async () => ok(await api('POST', '/divi/resave', null, ids ? { ids } : {}, site)))
);

// Divi - repair builder postmeta
server.tool('wp_divi_meta_set',
  'Apply Divi builder postmeta to an existing post without touching its content. Use this to repair a page '
  + 'that renders with a widget sidebar or a duplicated title because it was created through a route that '
  + 'did not set the meta (e.g. wp_posts_create on an older plugin version, or wp-cli post create).',
  {
    site:  S,
    id:    z.number().int().describe('Post ID'),
    force: z.boolean().optional().describe('Also overwrite existing layout choices'),
  },
  ({ site, id, force }) => safeCall(async () => ok(await api('POST', `/divi/meta/${id}`, null, { force }, site)))
);

// Rendered-page inspection
server.tool('wp_page_render',
  'Fetch a page as an anonymous visitor from the server and return a structural health summary: title, '
  + 'meta description, h1 count, heading outline, section count, images missing alt, empty paragraphs, '
  + 'whether block delimiters got HTML-escaped, and whether a widget sidebar is present. '
  + 'Use this to VERIFY a write actually produced what you intended - every other tool reports database '
  + 'state, and several classes of defect (wrong template, escaped blocks, broken heading structure) are '
  + 'only visible in the rendered output. Pass "expect" to assert instead of eyeballing.',
  {
    site:         S,
    id:           z.number().int().optional().describe('Post ID (or pass url)'),
    url:          z.string().optional().describe('Absolute URL (or pass id)'),
    expect:       z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
                    .describe('Assertions against summary fields, e.g. {"h1_count":1,"has_sidebar":false}. Response gains ok/failed.'),
    include_html: z.boolean().optional().describe('Also return the full HTML (often 100KB+; default false)'),
  },
  ({ site, id, url, expect, include_html }) => safeCall(async () => {
    if (!id && !url) throw new Error('Provide id or url');
    const params = {};
    if (id) params.id = id;
    if (url) params.url = url;
    if (expect) params.expect = JSON.stringify(expect);
    if (include_html) params.include_html = '1';
    return ok(await api('GET', '/render', params, null, site));
  })
);

// Content find/replace that understands builder escaping
server.tool('wp_content_replace',
  'Find and replace inside post content using PLAIN HTML, without needing to know how the builder '
  + 'escaped it. Use this instead of hand-writing SQL REPLACE for builder content. '
  + 'Divi 5 stores HTML inside block-attribute JSON, and the escaping differs by author: the visual '
  + 'builder writes angle brackets as \\u003c / \\u003e (serialize_block_attributes), hand-written JSON '
  + 'leaves them literal and escapes quotes as \\", and both variants exist on the same site. This tool '
  + 'tries every known encoding, reports which one matched and how many times, then writes using the '
  + 'matching encoding - and flushes Divi\'s CSS cache afterwards. '
  + 'Always dry_run first and check total_matches. If nothing matches, the response lists every '
  + 'encoding it tried so you can see whether it is an escaping problem or the string is simply absent.',
  {
    site:        S,
    search:      z.string().describe('Plain HTML or text to find, e.g. <h1>Title</h1>'),
    replace:     z.string().describe('Plain HTML or text to replace it with'),
    id:          z.number().int().optional().describe('Single post ID'),
    ids:         z.array(z.number().int()).optional().describe('Several post IDs'),
    all_builder: z.boolean().optional().describe('Every builder post on the site'),
    dry_run:     z.boolean().optional().describe('Report what would change without writing. Do this first.'),
    resave:      z.boolean().optional().describe('Also re-save each post so Divi regenerates its CSS'),
  },
  ({ site, ...body }) => safeCall(async () => {
    if (!body.id && !body.ids && !body.all_builder) throw new Error('Provide id, ids, or all_builder');
    return ok(await api('POST', '/content/replace', null, body, site));
  })
);

// Block validation
server.tool('wp_blocks_validate',
  'Check a post\'s Gutenberg/Divi 5 block markup for damage: HTML-escaped delimiters (kses corruption), '
  + 'unbalanced block comments, and attribute JSON that fails to round-trip. Divi 5 stores module '
  + 'attributes as JSON inside HTML comments, so one unbalanced brace corrupts a page with no parse error '
  + 'and the module silently renders with defaults. Returns per-block-type counts too.',
  { site: S, id: z.number().int().describe('Post ID') },
  ({ site, id }) => safeCall(async () => ok(await api('GET', `/blocks/validate/${id}`, null, null, site)))
);

// Knowledge base - search before troubleshooting
server.tool('wp_knowledge_search',
  'Search the shared claude-connector knowledge base for previously discovered WordPress/Elementor/Divi/hosting fixes before troubleshooting from scratch',
  {
    query:    z.string().describe('Keywords describing the problem'),
    category: z.enum(['elementor', 'divi', 'acf', 'hosting-waf', 'wp-cli-database', 'general']).optional(),
  },
  ({ query, category }) => safeCall(async () => ok(await searchKnowledge(query, category)))
);

// Knowledge base - record a fix after resolving something non-obvious
server.tool('wp_knowledge_add',
  'Record a non-obvious WordPress/Elementor/Divi/hosting fix to the shared knowledge base so future sessions on any site don\'t rediscover it. Generalize away site-specific names/URLs/secrets first. Requires the GitHub CLI (gh) to be installed and logged in.',
  {
    category: z.enum(['elementor', 'divi', 'acf', 'hosting-waf', 'wp-cli-database', 'general']),
    symptom:  z.string().describe('What went wrong / how it presented'),
    fix:      z.string().describe('What resolved it'),
    why:      z.string().optional().describe('Root cause, if known'),
  },
  ({ category, symptom, fix, why }) => safeCall(async () => ok(await addKnowledge({ category, symptom, fix, why })))
);

// Logs
server.tool('wp_logs_list', 'View recent Claude Connector API access log entries', {
  site:  S,
  limit: z.number().int().min(1).max(500).optional().describe('Number of entries (default 50)'),
}, ({ site, limit }) =>
  safeCall(async () => ok(await api('GET', '/logs', limit ? { limit } : null, null, site)))
);

// WP-CLI
server.tool('wp_wpcli',
  'Run a WP-CLI command on the WordPress site. '
  + 'PREFER "args" (array) over "command" (string) for anything containing quotes, newlines, $ or other '
  + 'shell metacharacters: args is passed straight to the process and skips shell interpretation entirely, '
  + 'so you can pass e.g. a whole --post_content=... argument with embedded quotes and newlines safely. '
  + '"command" goes through shell quoting and will break on those. '
  + 'Blocked for safety: shell, server, eval, eval-file, package (plus some subcommands). '
  + 'For bulk data work use wp_db_query with params, or the dedicated builder tools.',
  {
    site:    S,
    args:    z.array(z.string()).optional().describe('Preferred. Command args e.g. ["plugin","list","--format=json"]'),
    command: z.string().optional().describe('Fallback for simple commands with no special characters'),
  },
  ({ site, args, command }) =>
  safeCall(async () => {
    if (!args && !command) throw new Error('Provide args (array) or command (string)');
    return ok(await api('POST', '/wpcli', null, args ? { args } : { command }, site));
  })
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
