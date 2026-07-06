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

- **Don't pass the key as a URL parameter** (`?_key=...`). It works, but the key will appear in server access logs and browser history. Always use the header.
- **Don't commit the key to version control.** If you pin it via `wp-config.php`, make sure `wp-config.php` is in `.gitignore`.

### File access boundary

The `/files` endpoints enforce a hard boundary at `WP_CONTENT_DIR`. Path traversal attempts (e.g. `../../wp-config.php`) are blocked - `realpath()` is used to resolve symlinks and relative segments before the boundary check.

### Protected options

The following options cannot be modified via `/options` to prevent accidental site breakage:

`siteurl`, `home`, `admin_email`, `blogname`, `blogdescription`, `users_can_register`, `default_role`, `active_plugins`, `template`, `stylesheet`, WordPress auth/salt keys, and the connector's own API key.

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
