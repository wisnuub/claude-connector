# Claude Connector

A WordPress plugin that gives [Claude Code](https://claude.ai/code) (or any Claude AI agent) full programmatic access to a WordPress site — without needing cPanel, SSH, or hosting credentials.

Install it once on any WordPress site. Then tell Claude:

> *"Connect to **example.com** with key **`abc123...`**"*

Claude can then manage ACF field groups, flush caches, read and write theme files, query the database, create posts, and more — all through a secure REST API.

---

## Why this exists

When working with WordPress agencies or freelancers, developers often need access to a client's site to:

- Sync ACF field group JSON after uploading files
- Flush the page cache after deploying changes
- Read theme files to understand the current structure
- Create or update posts and options programmatically

Normally this requires cPanel access, SSH keys, or asking the client to do it manually. This plugin removes that friction entirely — the developer installs the plugin, shares the API key, and the AI agent handles the rest.

---

## Installation

### Option A — Upload zip (recommended)
1. Download `claude-connector.zip` from the [Releases](https://github.com/wisnuub/claude-connector/releases) page
2. WP Admin → **Plugins → Add New → Upload Plugin**
3. Upload the zip → **Install Now** → **Activate**

### Option B — Manual
1. Copy the `claude-connector/` folder to `/wp-content/plugins/`
2. Activate it from **WP Admin → Plugins**

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

`GET /acf/groups` — list all field groups with their key, title, active status, and field count.

`POST /acf/sync` — sync field groups from local JSON files (same as clicking "Sync" in ACF → Field Groups).

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
```

**Write (create or overwrite) a file:**

```json
POST /files
{
  "path":    "themes/my-theme/single-service.php",
  "content": "<?php\n// file content here"
}
```

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

// Execute (UPDATE/DELETE/INSERT — use carefully):
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

The `/files` endpoints enforce a hard boundary at `WP_CONTENT_DIR`. Path traversal attempts (e.g. `../../wp-config.php`) are blocked — `realpath()` is used to resolve symlinks and relative segments before the boundary check.

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

### 1.0.1
- PHP 7.4 compatibility: removed union return types, replaced `match()` with `switch`, added `str_starts_with()` polyfill

### 1.0.0
- Initial release
- Endpoints: status, ACF sync, cache purge, posts CRUD, options, plugins, themes, files, database
