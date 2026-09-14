# Claude Connector

A WordPress plugin that gives [Claude Code](https://claude.ai/code) (or any Claude AI agent) full programmatic access to a WordPress site - without needing cPanel, SSH, or hosting credentials.

Install it once on any WordPress site. Then tell Claude:

> *"Connect to **example.com** with key **`abc123...`**"*

Claude can then manage ACF field groups, flush caches, read and write theme files, query the database, create posts, and more - all through a secure REST API.

---

## Why this exists

When working with WordPress agencies or freelancers, developers often need access to a client's site to:

- Sync ACF field group JSON after uploading files
- Flush the page cache after deploying changes
- Read theme files to understand the current structure
- Create or update posts and options programmatically

Normally this requires cPanel access, SSH keys, or asking the client to do it manually. This plugin removes that friction entirely - the developer installs the plugin, shares the API key, and the AI agent handles the rest.

---

## Installation

### Option A - Upload zip (recommended)
1. Download `claude-connector.zip` from the [Releases](https://github.com/wisnuub/claude-connector/releases) page
2. WP Admin → **Plugins → Add New → Upload Plugin**
3. Upload the zip → **Install Now** → **Activate**

### Option B - Manual
1. Copy the `claude-connector/` folder to `/wp-content/plugins/`
2. Activate it from **WP Admin → Plugins**

---

## Auto-updates

The plugin isn't listed on wordpress.org, so it checks [GitHub Releases](https://github.com/wisnuub/claude-connector/releases) directly instead. Once a newer tag is published, **WP Admin → Plugins** shows the usual "update available" notice and **Update Now** installs it - no manual zip re-upload needed.

Release checks are cached for 12 hours. To ship a new version: bump `Version` in the plugin header, tag the commit (`vX.Y.Z`), and attach a `claude-connector.zip` build to the GitHub release.

---

## Connecting Claude Code (one-click setup)

**WP Admin → Settings → Claude Connector → Connect Claude Code** shows a download button for your OS (detected automatically, both shown if detection fails):

- **Mac** - double-click the downloaded `.command` file in Finder
- **Windows** - right-click the downloaded `.ps1` file → **Run with PowerShell**

The script installs the MCP bridge, creates a workspace folder for the site, writes `.mcp.json` + `CLAUDE.md`, and opens the folder in VSCode. Requires [Node.js](https://nodejs.org) and VSCode with the Claude Code extension.

---

## Shared knowledge base

Every generated `CLAUDE.md` tells Claude to check a running knowledge base ([KNOWLEDGE.md](KNOWLEDGE.md))
before troubleshooting an unfamiliar WordPress/Elementor/Divi/hosting issue, and to record a fix there
after solving something non-obvious - so the next site doesn't start from zero. This is two MCP tools,
not a WordPress REST endpoint, so it works the same regardless of which site you're connected to:

- **`wp_knowledge_search`** - reads `KNOWLEDGE.md` straight from GitHub (public, no auth needed) and
  returns matching entries.
- **`wp_knowledge_add`** - records a new entry. What happens depends on your [GitHub CLI](https://cli.github.com/)
  (`gh`) login:
  - **Not installed / not logged in** - the entry is saved locally only; Claude will tell you to run
    `gh auth login` if you want fixes shared.
  - **Logged in, no push access to this repo** - the entry is queued locally and opened as a single
    GitHub issue summarizing everything queued so far, at most once per calendar day (checked whenever
    a new finding comes in, not on a background timer).
  - **Logged in with push access** (the maintainer) - committed straight to `KNOWLEDGE.md`.

No GitHub token is stored anywhere - `gh` handles its own authentication, and a duplicate check against
existing entries runs before every write to avoid spamming the repo with near-identical findings.

---

## Configuration

After activation, go to **WP Admin → Settings → Claude Connector** to find your API key and the base URL.

### Optional: pin the key in wp-config.php

```php
// wp-config.php
define( 'CLAUDE_API_KEY', 'your-64-char-hex-key-here' );
```

This prevents the key from changing if the database is reset and is the recommended approach for long-term projects.

---

## Connecting Claude to a site

Give Claude the site URL and API key. No other credentials are needed.

**Example prompt:**

```
Connect to example.com
API key: a3f8c2d1e9b4...
```

Claude will use `https://example.com/wp-json/claude/v1/` as the base URL and authenticate every request with `X-Claude-Key: <key>`.

---

## API Reference

All endpoints are under `/wp-json/claude/v1/`. Every request must include the header:

```
X-Claude-Key: <your-api-key>
```

### Status

```
GET /status
```

Returns site info: WP version, PHP version, active theme, active plugins, timezone, etc.

---

### ACF

```
GET  /acf/groups
POST /acf/sync
```

`GET /acf/groups` - list all field groups with their key, title, active status, and field count.

`POST /acf/sync` - sync field groups from local JSON files (same as clicking "Sync" in ACF → Field Groups).

```json
// POST /acf/sync
// Sync all groups:
{}

// Sync specific groups only:
{ "groups": ["group_abc123", "group_def456"] }
```

---

### Elementor

```
GET  /elementor/widgets
GET  /elementor/data/{id}
POST /elementor/data/{id}
```

Lets Claude build and edit pages using Elementor's own native widget/module format
(`_elementor_data`), instead of writing raw HTML into `post_content`.

`GET /elementor/widgets` - lists every registered widget type on this site (stock Elementor,
Elementor Pro, and any third-party addon widgets) with its editable settings/control schema, so
Claude uses real field names instead of guessing.

`GET /elementor/data/{id}` - returns the decoded elements tree for a post plus edit-mode/version meta.

`POST /elementor/data/{id}` - writes an elements tree and clears Elementor's CSS cache so the change
renders immediately.

```json
// POST /elementor/data/42
{
  "elements": [
    {
      "id": "a1b2c3d",
      "elType": "section",
      "elements": [
        {
          "id": "e4f5g6h",
          "elType": "column",
          "elements": [
            { "id": "i7j8k9l", "elType": "widget", "widgetType": "heading", "settings": { "title": "Hello" } }
          ]
        }
      ]
    }
  ]
}
```

Requires the Elementor plugin to be active; returns `422` otherwise.

---

### Divi

```
GET  /divi/modules
GET  /divi/data/{id}
POST /divi/data/{id}
```

Same idea as the Elementor endpoints, for Divi. Divi has two generations with different content
formats - classic Divi (shortcodes in `post_content`) and Divi 5 (a newer structured module model) -
so responses include a `generation` field (`d4_shortcode` or `d5_json`). Module schema discovery is
currently only wired up for classic Divi; Divi 5 support is best-effort and may need adjusting
against a live site.

`GET /divi/modules` - lists known module types for the detected generation.

`GET /divi/data/{id}` - returns `post_content` plus Divi builder meta and the detected generation.

`POST /divi/data/{id}` - writes builder content. `content` must already match the site's detected
generation's format (shortcode markup for classic Divi, module JSON for Divi 5).

Requires Divi to be active; returns `422` otherwise.

---

### Cache

```
POST /cache/purge
```

Flushes all available caches automatically: WP object cache, transients, WP Engine page cache, W3 Total Cache, WP Super Cache, WP Rocket, and LiteSpeed Cache.

---

### Posts

```
GET    /posts
POST   /posts
GET    /posts/{id}
PUT    /posts/{id}
DELETE /posts/{id}
```

**Query posts:**

```
GET /posts?type=service&status=publish&search=cyber&per_page=10&page=1
```

**Create a post:**

```json
POST /posts
{
  "post_type":    "service",
  "post_title":   "Cyber Insurance",
  "post_content": "<p>Content here</p>",
  "post_status":  "publish",
  "meta_input":   { "custom_field": "value" }
}
```

**Update a post:**

```json
PUT /posts/42
{
  "post_title": "Updated Title",
  "post_status": "publish"
}
```

`GET /posts/{id}` returns the post with all meta fields and taxonomy terms included.

---

### Options

```
GET  /options?key=<option_name>
POST /options
```

```json
// Write an option:
POST /options
{ "key": "my_plugin_setting", "value": { "enabled": true } }
```

Some options are protected and cannot be written: `siteurl`, `home`, `active_plugins`, WordPress secret keys, and the connector's own API key.

---

### Plugins

```
GET  /plugins
POST /plugins
```

```json
// Activate a plugin:
POST /plugins
{ "plugin": "advanced-custom-fields/acf.php", "action": "activate" }

// Deactivate a plugin:
POST /plugins
{ "plugin": "wordfence/wordfence.php", "action": "deactivate" }
```

---

### Themes

```
GET  /themes
POST /themes
```

```json
// Switch active theme:
POST /themes
{ "stylesheet": "eightball-genesis-child" }
```

---

### Files

All file operations are restricted to `/wp-content/`. Paths outside this boundary return `403 Forbidden`.

```
GET    /files?path=themes/my-theme/
GET    /files/read?path=themes/my-theme/single-service.php
POST   /files
DELETE /files?path=themes/my-theme/old-file.php
POST   /files/stage
POST   /files/commit
```

**Write (create or overwrite) a file - plain content:**

```json
POST /files
{
  "path":    "themes/my-theme/single-service.php",
  "content": "<?php\n// file content here"
}
```

**Write with base64-encoded content (use when a WAF blocks PHP code in POST bodies):**

```json
POST /files
{
  "path":        "themes/my-theme/single-service.php",
  "content_b64": "PD9waHAKLy8gZmlsZSBjb250ZW50IGhlcmU="
}
```

#### WAF-bypass two-step write (`/files/stage` + `/files/commit`)

Use this when a firewall (e.g. Cloudflare managed rules) blocks any POST body containing PHP code patterns. The content is sent as base64 in one or more small chunks, stored as transients, then written to disk by a separate commit call that carries no file content at all.

**Step 1 - stage (repeat for each chunk):**

```json
POST /files/stage
{
  "path":        "themes/my-theme/single-service.php",
  "content_b64": "<base64-encoded chunk>",
  "chunk_index": 0,
  "chunk_total": 1
}
```

`chunk_index` is zero-based. For a single file, use `chunk_index: 0, chunk_total: 1`. Split large files into multiple chunks (max 200) and POST each one.

**Step 2 - commit:**

```json
POST /files/commit
{
  "path":        "themes/my-theme/single-service.php",
  "chunk_total": 1
}
```

Staged chunks expire automatically after 1 hour if commit is never called.

---

### Access Log

```
GET  /logs
POST /logs/clear
```

```
GET /logs?limit=100
```

Returns the most recent API requests (default 50, max 500). Each entry includes timestamp (UTC), client IP, HTTP method, endpoint, and response status.

```json
POST /logs/clear
{}
```

Clears all log entries. Equivalent to the "Clear Log" button in WP Admin → Settings → Claude Connector.

Logging can be enabled or disabled from the plugin's settings page. The **Last Access** row on the settings page always shows the most recent request regardless of whether full logging is enabled.

---

### Database

```
GET  /db/tables
POST /db/query
```

```json
// SELECT query:
POST /db/query
{
  "query": "SELECT ID, post_title FROM wp_posts WHERE post_type = 'service' AND post_status = 'publish'",
  "type":  "get_results"
}

// Single value:
POST /db/query
{ "query": "SELECT COUNT(*) FROM wp_posts WHERE post_status = 'publish'", "type": "get_var" }

// Execute (UPDATE/DELETE/INSERT - use carefully):
POST /db/query
{ "query": "UPDATE wp_options SET option_value = '1' WHERE option_name = 'my_option'", "type": "query" }
```

`type` must be one of: `get_results`, `get_row`, `get_var`, `get_col`, `query`.

---

## Security

### How the key is protected

- The API key is a 256-bit (64 hex char) random value generated on first activation.
- Authentication uses [`hash_equals()`](https://www.php.net/hash_equals) for constant-time comparison, preventing timing attacks.
- Keys passed as the `X-Claude-Key` header are not logged by default web servers.

### What to avoid

- **The API key is only accepted via the `X-Claude-Key` header** - there is no URL parameter fallback, so it can never end up in server access logs, browser history, or Referer headers.
- **Don't commit the key to version control.** If you pin it via `wp-config.php`, make sure `wp-config.php` is in `.gitignore`.

### File access boundary

The `/files` endpoints enforce a hard boundary at `WP_CONTENT_DIR`. Path traversal attempts (e.g. `../../wp-config.php`) are blocked - `realpath()` is used to resolve symlinks and relative segments before the boundary check.

### Protected options

The following options cannot be read or modified via `/options` (both `GET` and `POST`), to prevent accidental site breakage and to keep secrets out of API responses:

`siteurl`, `home`, `admin_email`, `blogname`, `blogdescription`, `users_can_register`, `default_role`, `active_plugins`, `template`, `stylesheet`, WordPress auth/salt keys, and the connector's own API key.

Note that this is a fixed blocklist, not a general secrets scanner - it won't catch, say, another plugin's API key stored inside a serialized option value under an unrelated option name. The `/db/query` and `/options` endpoints assume anyone holding the API key is fully trusted; see "Security" above.

### Regenerating the key

Go to **Settings → Claude Connector → Regenerate Key** at any time. The old key stops working immediately.

---

## How Claude uses this plugin

Once connected, Claude can handle tasks like:

```
"Sync the ACF field groups on example.com"
→ POST /acf/sync

"Flush the cache after those changes"
→ POST /cache/purge

"Show me all published service pages"
→ GET /posts?type=service&status=publish

"Read the current single-service.php"
→ GET /files/read?path=themes/eightball-genesis-child/single-service.php

"Update the hero heading on post ID 214"
→ PUT /posts/214

"What's in the wp_options table for the SEO plugin?"
→ POST /db/query
```

No SFTP. No SSH. No cPanel. No asking the client to do anything except install and activate the plugin once.

---

## Requirements

- WordPress 5.8+
- PHP 7.4+ (tested on 7.4, 8.0, 8.1, 8.2, 8.3)
- HTTPS strongly recommended (ensures the API key is encrypted in transit)

---

## Changelog

### 1.6.0 — Divi 5 hardening

Fixes a data-loss bug and closes the verification loop. Derived from building a
44-page Divi 5 site end to end through the connector.

**Fixed**

- **Builder content is no longer destroyed on write.** None of the three
  transports called `wp_set_current_user()`, so every request ran as user 0.
  WordPress attaches the kses filters whenever the current user lacks
  `unfiltered_html`, so `wp_insert_post()`/`wp_update_post()` HTML-escaped block
  delimiters — `<!-- wp:divi/section -->` became `&lt;!-- wp:divi/section --&gt;`
  — which silently made the layout unparseable while returning HTTP 200. The
  connector now assumes a real user (configurable, defaulting to the
  lowest-numbered administrator) at the single auth choke point, and explicitly
  drops the kses filters on multisite where administrators don't hold
  `unfiltered_html`. This also fixes `post_author` defaulting to 0.
- **Every content write is verified.** Block markup is re-read after writing and
  the request fails loudly if the delimiters were escaped, so this can never
  regress silently again.
- **`POST /divi/data/{id}` now applies the full Divi 5 postmeta set.** It set
  only `_et_pb_use_builder`, which is enough for Divi 4 but leaves a Divi 5 page
  rendering on the theme's default template with a widget sidebar and a
  duplicated title. `wp_posts_create`/`wp_posts_update` infer the same when they
  detect `<!-- wp:divi/` in the content.
- **`GET /options` and `POST /options` accept dotted paths**
  (`et_divi.divi_integration_head`), so a single value inside a serialised theme
  options array can be read or patched without pulling and rewriting the whole
  blob. The protected-options blocklist is enforced on the root key.

**Added**

- `GET /render` — fetch a page server-side as an anonymous visitor and return a
  structural health summary (h1 count, heading outline, sections, images missing
  alt, empty paragraphs, escaped-delimiter detection, sidebar presence).
  Optional `expect` assertions turn verification into one call. Every other
  endpoint reports database state; several classes of defect are only visible in
  the rendered output.
- `POST /content/replace` — find and replace inside post content using **plain
  HTML**, without needing to know how the builder escaped it. Block attributes
  are JSON inside an HTML comment, so the HTML within them is escaped — and how
  depends on the author: the Divi 5 visual builder writes `<h1>` while
  keeping quotes as `\"`, whereas hand-written block JSON leaves the brackets
  literal and escapes only the quotes. Both forms coexist on one site, so a
  plain-HTML `REPLACE()` matches neither, and a SQL replace that matched nothing
  is indistinguishable from one that worked. This endpoint tries every known
  encoding, reports which matched and how many times, writes using the matching
  one, revalidates the blocks and flushes Divi's CSS cache. Supports `dry_run`,
  a single `id`, an `ids` list, or `all_builder`. When nothing matches it
  returns every encoding it tried.
- `GET /blocks/validate/{id}` — reports kses corruption, unbalanced block
  delimiters, and attribute JSON that fails to round-trip through
  `parse_blocks()`/`serialize_blocks()`. Divi 5 stores module attributes as JSON
  inside HTML comments, so one unbalanced brace corrupts a page with no parse
  error.
- `GET /divi/audit` — finds builder pages with missing postmeta, and pages where
  Divi's generated per-module CSS indices don't match the rendered markup. The
  latter happens after a plugin install/update invalidates Divi's caches and
  makes *all* attribute styling stop applying sitewide, with nothing wrong in
  the database.
- `POST /divi/resave` — the standing remedy for the above, and the required
  follow-up after editing `post_content` with raw SQL.
- `POST /divi/meta/{id}` — repair builder postmeta on an existing page without
  touching its content.
- `POST /files/fetch` — download a URL straight into `wp-content` server-side,
  so generated content no longer has to be transmitted through the model's
  context. Returns a `sha256` for verification without a read-back. Runs the
  same `php -l` guard as `/files`.
- **`POST /db/query` improvements:** `params` for `$wpdb->prepare()` bound
  placeholders (builder content contains backslash-escaped quotes, and
  hand-escaping through JSON needs three levels); `changed_rows` in the response,
  which is what distinguishes a real edit from a statement that matched a row
  but altered nothing; `dry_run` to rehearse a write inside a transaction and
  roll it back; and an explicit warning when rows matched but none changed.
- **`POST /cache/purge` is builder-aware:** `builder: true` also clears Divi's
  `et-cache` directory and `_divi_dynamic_assets_cached_*` postmeta plus
  Elementor's generated CSS — none of which a raw SQL write invalidates.
  `resave_builder_posts: true` additionally forces clean CSS regeneration.
- **`GET /status` reports `acting_as`** (user, login, whether it holds
  `unfiltered_html`) and a `builder` block, so misconfiguration is visible
  before it corrupts anything.
- **MCP server version handshake.** The server compares its own version against
  the plugin's on startup and in `wp_status`, and warns on mismatch. A stale copy
  of `mcp-server/index.js` silently fails to register newer tools, which is much
  harder to notice than an error — during the build this report came from, three
  Divi tools were missing for exactly that reason.
- Tool descriptions now document that `wp_wpcli` should be called with `args`
  (array) rather than `command` (string) for anything containing quotes,
  newlines or shell metacharacters, and list the blocked subcommands
  (`shell`, `server`, `eval`, `eval-file`, `package`).
- `KNOWLEDGE.md` gains a filled-in Divi section covering the CSS index bug, the
  Divi 5 postmeta set, attribute-path traps, the Integration → Head specificity
  problem, and hero/first-section scoping.

### Unreleased
- **Elementor native module support**: new `/elementor/widgets`, `/elementor/data/{id}` endpoints let Claude read/write pages using Elementor's own `_elementor_data` format and real widget/control names, instead of raw HTML.
- **Divi native module support**: new `/divi/modules`, `/divi/data/{id}` endpoints, generation-aware (`d4_shortcode` vs `d5_json`); Divi 5 module schema discovery is best-effort pending verification against a live site.
- **Shared knowledge base**: `wp_knowledge_search` / `wp_knowledge_add` MCP tools let Claude check for and record WordPress/Elementor/Divi/hosting fixes across sites via a `KNOWLEDGE.md` in this repo, using the GitHub CLI's own auth (maintainers commit directly; others queue into a daily digest issue). See [Shared knowledge base](#shared-knowledge-base).

### 1.4.1
- **Security hardening**: the API key is now accepted only via the `X-Claude-Key` header - the `?_key=` URL parameter fallback (and the admin-ajax `$_REQUEST` fallback, which also read cookies) has been removed, since query strings can leak into server logs, browser history, and Referer headers.
- **`GET /options` now respects the protected-options blocklist** (previously only `POST /options` did), so secrets stored under blocked option names can't be read back via the API either.
- Settings page: the API key field is masked by default (with a Show/Hide toggle), and the "Test connection" button now sends the key as a header via JavaScript instead of embedding it in a clickable URL.

### 1.4.0
- **GitHub-based auto-updates**: no wordpress.org listing needed - WP Admin → Plugins now checks GitHub Releases directly and supports one-click **Update Now**
- **Admin-AJAX connection mode**: bypasses Cloudflare/WAF blocking of direct REST API calls by routing through `wp-admin/admin-ajax.php`
- **WP-CLI support** and **MCP server**: local Node.js bridge exposes the plugin's endpoints as MCP tools for Claude Code, with per-site workspace folders
- **One-click setup scripts**: Settings page now offers a Mac (`.command`) and Windows (`.ps1`) download that installs the MCP bridge, writes `.mcp.json` + `CLAUDE.md`, and opens the workspace in VSCode automatically - the download button shown is now detected from the visitor's browser
- Removed the Cloudflare Worker relay system in favor of the simpler admin-ajax bridge

### 1.1.0
- **WAF-bypass file writes**: `POST /files` now accepts `content_b64` (base64-encoded content) as an alternative to `content`, avoiding Cloudflare and other WAF rules that match PHP code patterns in POST bodies
- **Chunked staging**: new `POST /files/stage` + `POST /files/commit` endpoints for multi-chunk base64 uploads - send any size file through a WAF in small pieces with no PHP code visible in any request body
- **Access log**: new `wp_claude_log` database table records IP, method, endpoint, status, and timestamp for every API request
- **Log endpoints**: `GET /logs` and `POST /logs/clear`
- **Settings page improvements**: "Last Access" row always shows most recent request (like cPanel's last login); logging can be toggled on/off without losing the last-access display

### 1.0.1
- PHP 7.4 compatibility: removed union return types, replaced `match()` with `switch`, added `str_starts_with()` polyfill

### 1.0.0
- Initial release
- Endpoints: status, ACF sync, cache purge, posts CRUD, options, plugins, themes, files, database
