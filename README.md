# Claude Connector

A WordPress plugin that gives [Claude Code](https://claude.ai/code) (or any Claude AI agent) full programmatic access to a WordPress site - without needing cPanel, SSH, or hosting credentials.

Install it once on any WordPress site. Then tell Claude:

> *"Connect to **example.com** with key **`abc123...`**"*

Claude can then manage ACF field groups, flush caches, read and write theme files, query the database, create posts, and more - all through a secure REST API.

It also ships a **local maintenance dashboard** for looking after many sites at once: bulk core/plugin/theme updates with automatic rollback, plugin management, and a real contact-form test on every site, grouped by agency and scheduled for the morning. See [Maintenance dashboard](#maintenance-dashboard-many-sites).

It can also **design and build pages in Divi 4/5 and Elementor** with native modules, to the standard of a hand-built site, and look at the result in a real browser while it works. See [BUILDING.md](BUILDING.md) for the method and the safety rules for working on a client's live site, and [DESIGN-STYLES.md](DESIGN-STYLES.md) for the award-site style archetypes to choose from.

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

**WP Admin → Settings → Claude Connector → Connect Claude Code**:

- **Mac** - three ways, all ending in the same workspace:
  1. **Connect on this Mac** - one click, when the [Site Maintenance app](#maintenance-dashboard-many-sites) is installed (`npm run shortcut` in `dashboard/`). The browser asks to open Site Maintenance; the dashboard shows the site and asks before setting anything up, then creates the workspace, refreshes the MCP bridge, opens VS Code and lists the site. Nothing is downloaded, so Gatekeeper is not involved.
  2. **Copy & paste in Terminal** - click **Show setup command**, paste it into Terminal and press Return. The script is fetched with `curl`, so there is nothing for Gatekeeper to block.
  3. **Download the installer** - a `.zip` holding the `.command`. Because it was downloaded, macOS blocks it once: double-click it, then **System Settings → Privacy & Security → Open Anyway**. (Zipped, it keeps its execute permission, so no `chmod +x`.)

  Options 1 and 2 carry the site's API key, so each link or command works once and expires after 15 minutes.
- **Windows** - download the `.ps1` file, right-click it → **Run with PowerShell**.

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

## Maintenance dashboard (many sites)

A local web app for routine maintenance across all your sites, in [`dashboard/`](dashboard/). It runs on your own computer, talks to each site through the connector, and keeps API keys on your machine.

```bash
cd dashboard
npm install
npm start            # → http://127.0.0.1:4590
```

Needs Node.js 18+ and Google Chrome or Microsoft Edge (for the form test). Every site must run Claude Connector **1.8.0 or newer**. The plugin's auto-updater gets them there.

**Shortcut (macOS):** `npm run shortcut` creates **Site Maintenance.app** in `~/Applications` and on the Desktop - open it from Spotlight, Launchpad or the Dock. It starts the dashboard if it is not running (through the background service when installed) and opens it in your browser. It also handles WP Admin's **Connect on this Mac** links (`claude-connector://`). It is built and signed (ad hoc) on your Mac, so Gatekeeper does not ask about it. `npm run shortcut -- --remove` deletes it; run `npm run shortcut` again if Node.js moves.

### Browser extension (Chrome / Edge)

A small **Claude Connector** extension (in [`dashboard/extension`](dashboard/extension)) does two things: its toolbar icon **opens the dashboard** in one click, and it lets **Log in** sign you into WordPress in a new tab of your own browser (rather than a separate window). It works the same on **Windows and Mac**, in Chrome or Edge, and there is nothing to run - no `.bat` or `.ps1`, just Chrome's built-in *Load unpacked*:

1. Open `chrome://extensions` (or `edge://extensions`) in a new tab.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and choose the `dashboard/extension` folder. (In the dashboard, **Settings → Log in → Open the folder** jumps straight to it.)
4. The **Claude Connector** icon (an orange link) appears in the toolbar. Pin it, then click it any time to open the dashboard.

The extension only talks to the dashboard on `127.0.0.1`; it holds a login in the browser's memory for the one tab it opens and drops it once you are signed in, when the tab closes, or after 10 minutes. Since it is loaded unpacked (not from the Chrome Web Store), the browser may occasionally remind you that a developer-mode extension is installed - that is normal.

**Running the dashboard on Windows:** there is no app bundle as on macOS, but nothing to distrust either - in the `dashboard` folder run `npm install` once, then `npm start`, and open `http://127.0.0.1:4590` (or just click the extension icon). To keep it running in the background across restarts, add that `npm start` as a Task Scheduler task at logon, or use a process manager such as `pm2`.

### Where the sites come from

Nothing to configure for sites set up with the [one-click installer](#connecting-claude-code-one-click-setup): the dashboard reads every `~/claude-sites/<site>/.mcp.json` (URL, key and connection mode) and watches the folder, so a newly installed site appears within seconds - no reload - marked **New**. It also reads `mcp-server/sites.json`, and you can **Add site** by hand. Each site's **WordPress & server** tab has **Change URL…** (e.g. when a site moves off a `/newsite` staging path to its live address - it rewrites the address in the site's `~/claude-sites` workspace, keeping its history), **Hide from dashboard** (leaves the folder in place; show it again from Settings) and **Delete site** (removes the workspace folder too). **Hide** removes a site from the dashboard without touching its folder. Nothing is sent to a site until you press a button.

### What it does

- **One row per site**: WordPress version (and pending core update), **PHP version** (red when no longer supported, amber when security support ends within six months), pending updates, health, last form test, last run. Click a row to open it. Each row has **Check** (read-only inspection) before **Update all**.
- **Plugins tab**: every plugin with version → new version (flagged when an update needs a licence key or a newer PHP), an active/inactive switch, Update, Delete, and **Versions** to install another version from wordpress.org (a rollback). Tick several for bulk update / activate / deactivate / delete. Search wordpress.org and install (optionally activate) from the same tab.
- **Themes, WordPress & server, Form test, History** tabs for the rest.
- **Bulk across sites**: tick sites (or a whole agency) and run **Check everything** (read-only: updates, health, security and Divi forms - the counterpart to Update everything, changing nothing), **Update everything**, **Form test now**, **Queue form test**, or a **Plugin…** action (install / update / activate / deactivate / delete one plugin on every selected site).

**Update everything** first shows a checklist of every pending update on the chosen sites, all ticked: untick what you don't want this time. **Hold** keeps an item (a plugin, theme, core or translations on one site) at its current version on every run until you release it - held items are tagged in the plugin table. Updates that cannot go in (licence missing, PHP too old) are shown greyed out with the reason.

The run itself, per site: health check → each plugin, one at a time (Claude Connector last) → themes → WordPress minor update (major only if allowed in Settings) → translations → health check from inside and from outside → form test (now, queued for the morning, or skipped - your choice in Settings). Up to four sites run in parallel; a site always runs one step at a time, so when something breaks it is clear what did it.

Every plugin and theme update is **backed up, health-checked and rolled back automatically** if the site then fatals - see [`/maintenance/update`](#maintenance). Updates without a download (expired licence) and updates needing a newer PHP are skipped with a warning rather than attempted.

### Log

**Log** (top of the page) lists every run with, per site, what was **updated** (from → to), what was **not done** and why (left out, held, licence missing, PHP too old, major core update, site already broken, run stopped part-way) and what **failed** (rolled back, update error, broken site, failed form test) with the error. Filter by period, agency, problems / updates / everything; **Copy report** gives plain text to paste into an email or chat, **Download CSV** a spreadsheet.

The same is appended to plain text files, one per month, in `dashboard/data/logs/maintenance-YYYY-MM.log`.

When a site's last run failed, a red banner at the top lists it (and the first failure) until you dismiss it, and macOS shows a notification - useful for the background morning run. Turn the notification off in Settings.

### Asana and WordPress logins

Connect Asana under **Settings → Asana** with a personal access token (Asana: profile picture → Settings → Apps → Developer apps → Create new token). The token is kept in the macOS Keychain.

- **Tasks** (top of the page) lists your incomplete Asana tasks in the chosen workspace, with project, matching site, due date and Actual time. Filter to tasks whose site is on the dashboard or not yet.
- **Which task belongs to which site** is matched by project name ("Eccentric Engineering" ↔ eccentricengineering.com.au), preferring the "wordpress update" task when a project has several. Change it in the site's **Asana & login** tab.
- **Do WordPress updates** (Tasks view) takes every open task titled *WordPress update(s)* whose site is connected, links each site to that task and opens the update checklist for all of them.
- **Done this month** - a WordPress update task whose comments include this month's "…update done" (or "no updates needed") is hidden from the Tasks view and skipped by Do WordPress updates; **Show done this month** brings them back, tagged with the date. Tasks are never marked complete from the dashboard - whoever signs the work off does that in Asana.
- **Results go back to Asana** as one line in the team's usual words, built from what the run did - for example *"WP core + plugin update done, test form sent, site cleaned from malicious code"* or *"Plugin update done, no test form sent/no contact form available on the site"*. "WP core" appears only when core was updated; "site cleaned from malicious code" when the previous security check found warning signs and this run's check is clean; failed updates, a captcha-blocked form or remaining warning signs are said too. When the form test waits for the morning run, the comment goes out with it. Settings → Asana switches to the detailed log, or turns automatic posting off. Optionally the run's time is added to Actual time (needs time tracking on your Asana plan).
- **Last WordPress update** (a site's Asana & login tab) shows whether the linked task has been marked complete (and by whom, when) - which it reads even after completion drops the task from "my tasks" - plus the latest comment and the latest "update done" comment, so you can see what's been acknowledged and whether you've already let the reviewer know without commenting twice.
- **Comment for Asana** (a site's Asana & login tab) shows that line for the last run, editable, with **Send** - for posting by hand.
- **Logins**: **Login** on a task (or **Show login from Asana** on a site) finds the project's **Login** / **Logins** / **Login detail** / **Login details** task and reads it as a history - its description, then its comments oldest to newest: username on one line and password on the next, optionally the `wp-admin` address above them, or just a new password on its own line when only the password changed. The newest login is shown first; the username and address carry over from earlier comments. Labelled lines (`Username: …` / `Password: …`) work too. If there is no Login task it looks in the task itself, the project's description and overview, and the task's comments. When a login has no address and the site is not on the dashboard, **Log in** asks for it once per project. They are read when you ask and not stored by the dashboard. Copy the username or password, or press **Log in**, which opens the site's login page, fills it in and signs in - on any WordPress site, with or without the connector:
  - **In a new tab of your own browser**, once the **Claude Connector** browser extension is installed (Chrome or Edge, Windows or Mac - see [Browser extension](#browser-extension-chrome--edge)). Only the dashboard can ask it to log in; it keeps each login in memory for that one tab and drops it once you are in, when the tab closes, or after 10 minutes.
  - **In a separate browser window** otherwise (its own profile, remembered between uses). Chrome does not let other programs fill in forms in your everyday browser, which is why the extension is needed for the tab.
  - When a security check comes before the login form, it waits and fills the form in once it appears. A captcha on the form is left to you: the username and password are filled in, you complete the captcha and press **Log In**. Two-factor codes are yours too.

### Security check

**Security check** (per site in its **Security** tab, or for every selected site from the toolbar) runs a read-only scan on the site - nothing is changed - and lists warning signs by severity:

- WordPress core files that differ from wordpress.org's checksums, files in `wp-admin` / `wp-includes` that are not part of WordPress, and extra PHP files in the site root.
- wordpress.org plugins whose files differ from the published version, or carry PHP files the published version does not have.
- Active plugins whose files are missing (the "Plugin file does not exist" deactivation) and recently deactivated plugins.
- PHP files in uploads, and code matching known malware patterns (decoded `eval`, web shells, commands run from request data, obfuscation) in themes, plugins, mu-plugins and drop-ins.
- Administrators created in the last 30 days, `.htaccess` redirects to other domains, suspicious lines in `wp-config.php` (only the matching line is shown, never the credentials), scripts in posts and settings, and a site address pointing elsewhere.

"Update everything" runs the security check after updating, too (Settings → Updates), which is how the Asana comment knows a site was cleaned.

A planted file that is not part of WordPress - including one outside `wp-content` (the root, `wp-admin`, `wp-includes`) - can be removed with **quarantine**: it is moved into a hidden folder, not deleted, so it can be restored. Genuine core files are refused (reinstall core to fix those), as are `wp-config.php` and anything outside the install. Claude in VS Code does this with `wp_quarantine_file`, after examining the file and with your agreement.

Findings are leads, not proof. **Open in VS Code with Claude** writes them to `SECURITY-REPORT.md` in the site's workspace and opens it, with instructions for Claude to investigate each finding with the connector's MCP tools (including `wp_security_scan` to re-run the check), explain what it finds and propose a cleanup plan - and to change nothing until you agree to it.

### Agencies

If you maintain sites for more than one agency, add each under **Settings → Agencies** and assign sites to them (per site in its Form test tab, or several at once with **Agency…**). The list is then grouped by agency, with a filter and a select-all / "Update everything for …" per group.

Each agency has its own **form-test details**: the name, email, phone, company, subject and message typed into contact forms. `{ref}` becomes a short reference code (also shown in the result) to search the inbox for. Sites without an agency use the default one's.

### The form test

The dashboard opens the site's contact page in a real (headless) browser, fills the form in and presses submit, then reads the form plugin's own success or error message. That tests the form, its validation, spam protection and mail step together - not just `wp_mail()`.

- **Which form**: the site lists pages with a form (Divi 4/5, Contact Form 7, Gravity Forms, WPForms, Elementor Pro, Fluent Forms, Forminator, Ninja Forms, Divi Theme Builder footers); contact pages first. Pick another page or enter any URL in the Form test tab.
- **Which value goes where**: field names differ per plugin (`et_pb_contact_name_0`, `your-name`, `name-1-first-name`), so each visible field is matched on what a person reads - its type (`email`, `tel`, `url`, `textarea`...) first, then its label, placeholder, aria-label and name - to the agency's name / first / last name, email, phone, company, subject or message. Dropdowns get a real option (not "Please select"), radio groups one choice, required and consent checkboxes are ticked. Hidden fields (honeypots) are left alone. **Divi's math captcha** and other "3 + 4 =" questions are solved.
- **Field rules** (per agency) cover the rest: "if a field's label/placeholder/name contains *X*, use *Y*", e.g. `hear about` → `Google`, `ABN` → `12 345 678 901`. For a dropdown or radio group the value picks the option with that text; **`{random}`** picks a random option, **`{first}`** the first, **`{skip}`** leaves the field alone, and `yes` ticks a single checkbox. Each agency can also make dropdowns without a rule pick a random option.
- **Result**: Sent / Failed (with the plugin's message, e.g. CF7's "One or more fields have an error") / Captcha (reCAPTCHA v2, hCaptcha or Turnstile, or an anti-spam answer such as "You must be a human to submit this form." - these turn automated tests away, test the form by hand) / No reply, plus exactly what was typed into each field and a screenshot.
- With no form on the site, a plain `wp_mail()` test is sent instead (optional), reporting the SMTP plugin in use or warning when mail goes out through PHP `mail()`.

**Divi email pattern** (Form test tab, or **Check Divi forms** for selected sites): Divi only emails the fields named in a contact form's *Message Pattern*, and a placeholder whose ID does not match a field (`%%Service%%` for a field with ID `services`) is dropped silently. The check lists every Divi 4 contact form - pages and Theme Builder layouts - with fields missing from its pattern and placeholders matching no field, and suggests a pattern listing every field (`Name: %%Name%%`, …, `Message:` then `%%Message%%`), which you can edit and **Set**. The previous pattern is kept on the site. Divi 5 forms are listed for checking in the builder.

A form test sends a real enquiry to the form's recipients - the message says it is an automated maintenance test.

### Morning form tests

Do the updates whenever suits you and let the form tests go out in the morning: with **After "Update everything", the form test… → Waits for the morning run** (the default), updated sites are queued, and **Settings → Morning form test** sends them at the time and on the days you choose (or every site, not just queued ones). **Queue form test** adds any selected sites by hand; **Run queue now** sends them straight away.

The schedule runs while the dashboard is running. On macOS, keep it running in the background - started at login, restarted if it stops:

```bash
npm run service:install     # launchd agent; dashboard stays at http://127.0.0.1:4590
npm run service:status
npm run service:uninstall
```

If the Mac is asleep at the set time, the run happens when it wakes (until midday). To wake it for the run: `sudo pmset repeat wake MTWRF 08:25:00`.

### Data and security

Everything lives in `dashboard/data/` (git-ignored): `settings.json`, `sites.json` (hand-added sites, **including their API keys**), `state.json`, `history.json`, `logs/`, and form-test screenshots. The server listens on `127.0.0.1` only, answers only to `127.0.0.1`/`localhost` host names (blocking DNS-rebinding pages), requires a custom header on every change (blocking cross-site form posts), and never sends API keys to the browser. `PORT`, `CC_SITES_DIR`, `CC_MCP_SITES` and `CC_DASHBOARD_DATA` override the port and file locations.

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
GET  /elementor/kit
GET  /elementor/data/{id}
POST /elementor/data/{id}
```

Lets Claude build and edit pages using Elementor's own native widget/module format
(`_elementor_data`), instead of writing raw HTML into `post_content`.

`GET /elementor/widgets` - lists every registered widget type on this site (stock Elementor,
Elementor Pro, and any third-party addon widgets) with its editable settings/control schema, so
Claude uses real field names instead of guessing.

`GET /elementor/data/{id}` - returns the decoded elements tree for a post plus edit-mode/version meta.

`GET /elementor/kit` - the active kit's global colours and typography: the site's own design tokens.

`POST /elementor/data/{id}` - writes an elements tree and clears Elementor's CSS cache so the change
renders immediately. Optional `page_settings` (merged into `_elementor_page_settings`, e.g.
`{"hide_title":"yes"}`), `page_template` and `template_type`. On an `elementor_library` post the
template type defaults to `page` and the library term is set, so the item appears in My Templates.
The response's `warnings` flag settings that save fine but render wrong - an Image widget with no
`image.url` (renders nothing), an overlay with no `background_overlay_opacity` (renders at 50%).

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
GET  /divi/modules[?name=divi/button]
GET  /divi/data/{id}
POST /divi/data/{id}
POST /divi/library
```

Same idea as the Elementor endpoints, for Divi. Divi has two generations with different content
formats - classic Divi (shortcodes in `post_content`) and Divi 5 (block markup with JSON
attributes) - so responses include a `generation` field (`d4_shortcode` or `d5_json`). See
[DIVI5.md](DIVI5.md) for the Divi 5 write workflow.

`GET /divi/modules` - on Divi 5, every module from the schema Divi itself ships
(`_all_modules_metadata.php`): name, title, category, Divi 4 shortcode. Add `?name=divi/button` for
that module's attribute groups and paths (`button.innerContent`, `module.decoration.spacing` ...).
On Divi 4, the `ET_Builder_Element` registry.

`POST /divi/library` - saves a layout to the Divi Library with the terms and meta the library needs
(`{ "title", "content", "layout_type": "layout|section|row|module", "id"? }`). A library item changes
nothing until someone loads it into a page.

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
// Activate a plugin (the site is loaded with it first; a plugin that fatals is
// refused with activation_blocked and left inactive):
POST /plugins
{ "plugin": "advanced-custom-fields/acf.php", "action": "activate" }

// Deactivate a plugin:
POST /plugins
{ "plugin": "wordfence/wordfence.php", "action": "deactivate" }

// Install from wordpress.org (or "url": a plugin zip), optionally activating:
POST /plugins
{ "action": "install", "slug": "wp-mail-smtp", "activate": true }

// Roll back / pin a wordpress.org plugin to a version:
POST /plugins
{ "action": "install", "slug": "contact-form-7", "version": "6.0.6", "overwrite": true }

// Update (same as /maintenance/update with type plugin) or delete:
POST /plugins
{ "plugin": "contact-form-7/wp-contact-form-7.php", "action": "update" }
POST /plugins
{ "plugin": "hello.php", "action": "delete" }
```

Claude Connector refuses to deactivate or delete itself - that would cut off access to the site. An install that overwrites an active plugin is health-checked and rolled back like an update.

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

### Maintenance

```
GET  /maintenance/overview?refresh=1
POST /maintenance/update
GET  /maintenance/health
GET  /maintenance/forms
POST /maintenance/test-email
```

**`/maintenance/overview`** - everything needed to plan maintenance in one call: WordPress version with the newest minor (same branch) and major update offers, PHP version, every plugin and theme with version, available update (`package: false` = licence missing), PHP requirement, active state, pending translations, the active SMTP plugin, the filesystem method, and `stuck_maintenance` (a `.maintenance` file left by an interrupted update). `refresh=1` asks wordpress.org again first.

**`/maintenance/update`** - updates **one** item per request:

```json
{ "type": "plugin", "item": "contact-form-7/wp-contact-form-7.php" }
{ "type": "theme",  "item": "twentytwentyfive" }
{ "type": "core" }                       // minor update on the current branch
{ "type": "core", "allow_major": true }  // or the newest release
{ "type": "translations" }
```

For a plugin or theme the installed copy is first copied to `wp-content/claude-rollback/` (protected, removed afterwards), the update runs, and - if the plugin is active or the theme in use - the dashboard and homepage are loaded with WordPress's own fatal-error check. On a fatal the copy is put back and the request returns **422 `update_rolled_back`** with the error. The rollback runs inside the same request, which still has the old code loaded, so it works even when the new version would kill every later request. Active plugins stay active (core's upgrader would otherwise deactivate them silently over REST). Responses include `from`, `to`, the upgrader's messages and `health` (`ok`, or `unverified` when the site cannot be loaded from itself). Core updates are health-checked but not rolled back.

**`/maintenance/health`** - the same fatal-error check on its own, plus `stuck_maintenance`.

**`/maintenance/forms`** - published pages carrying a contact form, with the plugin(s) behind each, contact pages first.

**`/maintenance/test-email`** - `{ "to": "...", "ref": "..." }` sends a plain `wp_mail()` test (to the admin email by default) and returns whether WordPress accepted it, any mailer error and the SMTP plugin in use.

All of these refuse with `file_mods_disabled` when `DISALLOW_FILE_MODS` is set, and with `filesystem_unavailable` when WordPress cannot write files directly and no FTP credentials are configured.

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

### 1.8.8 — Security scan: every embed in a module, and widget providers

**Changed (the security check)**

- **Every script and iframe in a block of content is now checked, not just the first** - so a legitimate embed and a planted one in the *same* Divi Code module (two code blocks in one module) are told apart: the Map or video reads as normal and the injected script/iframe is still flagged.
- **An inline `<script>` that builds a script element, loads an external `src`, or redirects the browser elsewhere is flagged** (plain analytics/dataLayer code is left alone; obfuscated code is already caught).
- **Review, social-feed and form widget providers are allowlisted** so their embed code is not mistaken for an injection: Trustindex (Google Reviews), Elfsight, Curator, SociableKit, EmbedSocial, POWr, Tagembed, Reviews.io, SnapWidget, LightWidget (Instagram), Birdeye, Mailchimp, HubSpot, Klaviyo, Cookiebot/OneTrust and the usual Google/YouTube/Vimeo/Facebook/Instagram/Stripe hosts, across regional domains.

**Verified** on a local WordPress: a Google Map plus a malicious iframe, a malicious external script, and a malicious inline injector in the *same* Code module were each flagged while the Map stayed clean; a Map-only module and a Map + Google Analytics module were clean; Trustindex, Elfsight, LightWidget and SnapWidget embeds were clean; and a malicious script next to a Trustindex embed was still flagged.

### 1.8.7 — Security scan: allow embed iframes

**Fixed (the security check)**

- **Legitimate embed iframes are no longer flagged as injections.** The content scan now allowlists iframes from known embed providers - Google Maps (any regional domain, e.g. `www.google.com/maps`, `maps.google.com.au`), YouTube, Vimeo, Facebook/Instagram, Spotify/SoundCloud, OpenStreetMap, Bing, Google Docs/Forms/Calendar, Calendly, Airtable, JotForm, Acuity, TripAdvisor and Trustpilot - so a Maps or video embed in a Divi Code module or Elementor widget reads as normal. An iframe from an unknown domain, or obfuscated code, is still flagged.

**Verified** on a local WordPress: Google Maps embeds (`www.google.com` and `maps.google.com.au`) and a YouTube embed in Divi Code modules were not flagged, while an iframe from an unknown domain still was.

### 1.8.6 — Deeper security scan: builder content and accounts

**Changed (the security check)**

- **Injected code in content now covers page builders.** As well as post content, it reads **Divi Code modules** (decoding Divi's `||et_pb_line_break_holder||` / `%22` encoding) and **Elementor** widget data in postmeta, and reports the actual snippet and the outside domain - so a planted `<script>` or iframe hidden inside a builder module is visible even though it lives in the database, not a file. Scripts from known providers (Google, Facebook, Stripe, YouTube, jQuery/CDNs, chat widgets…) are not flagged; unknown external or obfuscated ones (eval/atob/base64/char-code/escaped-hex, meta-refresh) are. Settings (`wp_options`) are scanned the same way.
- **Administrator accounts are audited, not just counted.** Each admin is listed with its email, registration date and post count, and flagged when it looks out of place: created in the last 30 days, a machine-generated or common-attacker username (`admin123`, long random strings), or an email on an unrelated domain.

**Verified** on a local WordPress 7.1.3 with planted, inert fixtures: an external script in a Divi Code module and an obfuscated script in an Elementor widget were both detected with their snippet; a legitimate analytics tag in a Code module was not flagged; and four out-of-place admin accounts (random username, `admin123`, foreign email, recent) were flagged while an ordinary one was listed without a warning.

### 1.8.5 — Restore WordPress core files

**Added**

- **`POST /security/reinstall-core`** - restores every WordPress core file to the official copy for the **same version already installed** (like Dashboard → Updates → Re-install), fixing modified core files and putting missing ones back - in the site root, `wp-admin` and `wp-includes`, which the file tools cannot reach. Uses WordPress's own core upgrader and the no-content package, so `wp-content` (plugins, themes, uploads) is not touched and the version never changes. Reports how many core files were fixed and the site health. MCP tool `wp_reinstall_core`; the security report points Claude to it for "core files that differ / missing" findings.

**Verified** on a local WordPress 7.1.3: a tampered core file and a deleted core file were both restored (1 modified + 49 missing → 0 and 0), `wp-content` (an uploads file and an active plugin) was untouched, and the homepage stayed at 200.

### 1.8.4 — Remove malware outside wp-content (quarantine)

**Added**

- **`POST /security/quarantine`** - moves one added (non-core) file out of the live site into a hidden, request-blocked folder (`wp-content/uploads/.claude-quarantine`), **including files outside `wp-content`** (the site root, `wp-admin`, `wp-includes`) that the file tools cannot reach, which is where root-path malware hides. It is moved, not deleted, and can be put back with **`POST /security/restore`**; **`GET /security/quarantine`** lists what is held. Refused for genuine WordPress core files (matching wordpress.org's checksums - restore those by reinstalling core), `wp-config.php` and other config files, anything outside the WordPress install, and the connector itself. MCP tools `wp_quarantine_file`, `wp_quarantine_list`, `wp_quarantine_restore`; the security report tells Claude to use them for planted files once you have examined them and agreed.

**Verified** on a local WordPress 7.1.3: planted files in the site root and in `wp-admin` were quarantined (removed from the live site) and restored intact; a genuine core file, `wp-config.php` and paths outside the install were refused; the site stayed healthy throughout.

### 1.8.3 — Divi email patterns

**Added**

- **`GET /divi/forms`** - every Divi 4 contact form (pages and Theme Builder layouts) with its recipient, fields and email Message Pattern, the fields the pattern leaves out, placeholders that match no field ID, and a suggested pattern. **`POST /divi/forms/pattern`** sets one form's pattern in Divi's own format (line breaks as `||et_pb_line_break_holder||`), leaving the rest of the module untouched and keeping the previous pattern for undo. MCP tools `wp_divi_forms` and `wp_divi_form_pattern`.
- **Dashboard**: a Divi email pattern card in the Form test tab and **Check Divi forms** for selected sites.
- **`GET /security/core-file?path=`** - a WordPress core file and a line-by-line diff against the official copy for the site's version, for the security check's "core files that differ" findings (the file tools only reach `wp-content`). Read-only and limited to files in wordpress.org's checksum list, so `wp-config.php` and anything else outside core stay out of reach. MCP tool `wp_core_file_diff`; the security report tells Claude to use it, and how core is restored once you agree.

**Fixed (dashboard)**

- The form test fills a Divi field whose type is email with the email address whatever its label (a Careers form's "Availability" set as an email field failed as "Invalid email"), and picks the contact form over job application, newsletter and login forms.
- Results of a security check, form test or Divi check now appear without reloading the page.

**Verified** against the format read from live Divi forms, then on a local WordPress with a copy of a real Theme Builder footer form whose pattern used `%%Service%%` for a field with ID `services`: the check reported the missing field and the unmatched placeholder, Set stored the new pattern in Divi's format with every other attribute unchanged, and the re-check found every field.

### 1.8.2 — Security check

**Added**

- **`GET /security/scan`** - a read-only security check: WordPress core and wordpress.org plugin files against their published checksums, PHP files that do not belong (in `wp-admin` / `wp-includes`, uploads, the site root), known malware patterns in themes, plugins, mu-plugins and drop-ins, active plugins whose files are missing, recently changed PHP files, administrators (new ones flagged), `.htaccess` redirects, suspicious lines in `wp-config.php`, scripts in posts and settings, and a changed site address. MCP tool `wp_security_scan`.
- **Dashboard - Security**: a Security check button per site and for selected sites, findings in a Security tab, a "security" tag on sites with high findings, and **Open in VS Code with Claude**, which writes `SECURITY-REPORT.md` into the site's workspace (creating the workspace if needed) with instructions to investigate read-only and change nothing without your agreement.

- **Dashboard - Asana**: comments now default to one line in the team's words ("WP core + plugin update done, test form sent, site cleaned from malicious code"), posted with the morning form test when that is queued; a **Comment for Asana** box per site to edit and send by hand; **Do WordPress updates** runs every open WordPress update task. "Update everything" now includes the security check.

**Verified** on a local WordPress 7.1.3 with planted, inert stand-ins for each warning sign: a missing active plugin, a modified core file, an extra file in `wp-includes`, a modified wordpress.org plugin file, PHP in uploads, malware patterns in a theme, a spam redirect in `.htaccess`, a new administrator and a script injected into a post were all reported; the connector's own file (which names the patterns) is not.

### 1.8.1 — One-click Mac setup, Asana, Log in

**Added**

- **Three ways to set a site up on a Mac** (WP Admin → Settings → Claude Connector → Connect Claude Code), side by side:
  - **Connect on this Mac** - one click when the Site Maintenance app is installed: the browser hands a single-use link to the app, the dashboard shows the site and asks before creating the workspace, refreshes the MCP bridge and opens VS Code.
  - **Copy & paste in Terminal** - a single-use command that fetches the setup script with `curl`, so Gatekeeper is not involved and no `chmod +x` is needed.
  - **Download the installer** - now a `.zip`, so the `.command` keeps its execute permission and only needs Gatekeeper's one-time Open Anyway.

  Links and commands carry the site's API key, so each works once and expires after 15 minutes. Windows is unchanged.
- **Dashboard - Asana**: a Tasks view of your Asana tasks, each run's results posted as a comment on the site's task (optionally its time to Actual time), and WordPress logins read from the project's **Login** / **Logins** / **Login details** task (its comments, newest first). The token is kept in the macOS Keychain.
- **Dashboard - Log in**: signs in to any WordPress site, with or without the connector - in a new tab of your own browser through the new **Claude Connector** browser extension (`dashboard/extension`), or a separate window. A captcha on the login form is left to you; when a security check comes first, the form is filled in once it appears.

**Changed**

- **Site Maintenance.app** is now an AppleScript applet, signed ad hoc on your Mac: recent macOS refuses to open a bundle whose executable is a bare shell script, and only an applet can receive the Connect on this Mac links. Run `npm run shortcut` again to rebuild it.

**Verified** on a local WordPress 7.1.3: an installed 1.8.0 updated itself to 1.8.1 from this release; the Terminal command set a workspace up with no input and refused a second use; the zipped `.command` unzipped executable with Finder's unarchiver and `unzip`; Connect on this Mac went from link to app to dashboard to workspace, and refused reused, mismatched and non-site links. Asana was tested against a stand-in for its API (paging, Login task comments, comment HTML, a 402 for time tracking); the extension was loaded into Chromium and signed in, stopped at a captcha on the form, and stopped after one wrong password.

### 1.8.0 — Maintenance dashboard for many sites

**Added**

- **Maintenance dashboard** ([`dashboard/`](dashboard/)): a local web app for routine maintenance across all your sites - see [Maintenance dashboard](#maintenance-dashboard-many-sites). Finds the one-click installer's sites in `~/claude-sites` by itself; shows WordPress and PHP versions, pending updates and health per site; bulk updates across sites; plugin install / update / activate / deactivate / delete / version rollback, per site or across sites; sites grouped by agency.
- **Real contact-form test**: fills in and submits the site's form in a browser (Divi 4/5, Contact Form 7, Gravity Forms, WPForms, Elementor Pro, Fluent Forms, Forminator), solves Divi's math captcha, and reports the form plugin's own success or error message with what was typed where and a screenshot. Per-agency details and field rules (`{random}`, `{first}`, `{skip}` for dropdowns and radios).
- **Review before updating**: "Update everything" shows every pending update, all ticked - untick what to leave out; **Hold** keeps an item at its version on every run until released.
- **Maintenance log**: per run and site, what was updated, what was not done and why, and what failed - in a Log view (filters, copy as text, CSV) and monthly text files; a failure banner and a macOS notification when a run fails.
- **New sites appear live** when the one-click installer adds them to `~/claude-sites`.
- **Asana**: a Tasks view of your Asana tasks, each run's results posted as a comment on the site's task (and optionally its time), and WordPress logins read from Asana with copy buttons and a **Log in** button that signs you in in a separate browser window - for any site, with or without the connector.
- **Shortcut**: `npm run shortcut` creates Site Maintenance.app (Spotlight / Launchpad / Dock / Desktop), which starts the dashboard if needed and opens it.
- **Morning form tests**: updated sites are queued and tested at a set time and days; `npm run service:install` keeps the dashboard running in the background on macOS, and a run missed while the Mac slept happens on wake.
- **`/maintenance/*` routes**: `overview`, `update` (one plugin/theme/core/translations, backed up and **rolled back automatically on a fatal**), `health`, `forms`, `test-email`.
- **`POST /plugins` actions** `install` (wordpress.org slug, version or zip URL), `update` and `delete`.
- **MCP tools** `wp_maintenance_overview`, `wp_maintenance_update`, `wp_maintenance_health`, `wp_forms_list`, `wp_test_email`; `wp_plugins_manage` gains install / update / delete.

**Changed**

- **Activating a plugin is checked first**: the site is loaded with the plugin listed as active before `activate_plugin()` runs it in the API request. A plugin that fatals is refused (`activation_blocked`) with the error instead of the request dying with an empty response.
- **Claude Connector refuses to deactivate or delete itself** through its own API.
- The MCP server's relay transport waits up to 6 minutes for updates and installs (was 30 s for everything).

**Verified** on a local WordPress 7.1.3 (PHP 8.5): plugin, theme, core (minor, with the major offer left alone) and translation updates; a plugin update that fatals rolled back with the plugin left active; a fatal plugin refused on activation; install from wordpress.org, from a zip URL and at an older version; delete, including the refusal for the connector itself. Form tests submitted Contact Form 7 and Divi-markup forms (captcha solved, consent ticked, honeypot untouched, rules applied) and reported a CF7 validation failure as failed. The dashboard was driven in Chrome at desktop and phone width, light and dark, and all new MCP tools were called over stdio.

### 1.7.2 — PHP file writes fixed, automatic rollback on fatal errors

**Fixed**

- **Writing PHP files failed with HTTP 500** (e.g. a child theme's
  `functions.php`). The pre-write syntax check ran `PHP_BINARY -l`, but on a
  web server `PHP_BINARY` is php-fpm / lsphp / empty rather than the PHP CLI:
  php-fpm rejected every file as a "syntax error", an empty value threw a
  fatal `ValueError` on PHP 8, and lsphp could hang until the request timed
  out. The check now runs in-process (`token_get_all()` with `TOKEN_PARSE`),
  so it behaves the same on every host.
- **`write_failed` says why** - e.g. "directory is not writable by the web
  server user" - instead of just "Could not write file."

**Added**

- **Automatic rollback when a PHP write breaks the site.** A syntax check
  cannot catch fatals such as redeclaring a parent theme's function or calling
  one that does not exist. After every `.php` write (`/files`, `/files/commit`,
  `/files/fetch`) the plugin loads the dashboard and homepage using core's own
  check (the one the theme file editor uses). On a fatal error it restores the
  previous version - or removes a newly created file - and returns
  `php_fatal_rolled_back` with the error. Successful responses include
  `health.status`: `ok`, or `unverified` when the site could not be loaded to
  check (blocked loopback, page cache), in which case the write is kept.

**Verified** on a local WordPress 7.1.3 with a child theme: valid writes saved
and rendered; a syntax error, an undefined function, a redeclared `wp_head()`
and a new admin-only fatal were all rejected or rolled back through all three
write routes, with the homepage and dashboard returning 200 after every one.

### 1.7.1 — ACF backslash fix, scroll storytelling

**Fixed**

- **ACF field writes silently stripped backslashes.** `wp_acf_fields_set` and
  `wp_acf_options_set` passed values to `update_field()` unslashed, but ACF
  `wp_unslash()`es them on save (through `update_metadata()` for posts and
  explicitly for options), so `C:\path`, regex and escaped JSON lost their
  backslashes. Values are now slashed first, like every other write path.

**Verified** - the escaping of every builder write path, with deliberately hostile
content (quotes, Windows paths, regex, a literal `\u0022`, `-->` and fake block
comments, `<script>`, CSS custom properties, emoji, CJK, RTL, entities):
`tools/divi5.mjs` output parsed by WordPress's own block parser (8/8); posts,
meta, updates, find-and-replace and files round-tripped byte-exact on a live
site; Divi 5 and Divi 4 pages written, read back byte-exact and rendered with
no escaping debris on live sites.

**Motion** (`tools/motion/`)

- `m-pin` + `m-steps` / `m-steps-media`: scroll storytelling - a section holds
  still while list items activate one by one and the matching image crossfades
  in; stopping mid-crossfade glides to the next whole step (works with Lenis).
  Step images are loaded and decoded up front so crossfades don't stutter.
- `m-pin` + `m-fill`: a statement holds until every word has filled.
- `m-load`: a hero's reveals play on page load instead of on scroll.
- `m-fill`, `m-horizontal`, `m-magnetic` effects.
- Pins centre below a fixed header, re-measured once scrolled (many headers
  shrink); the height is published as `--m-header` for full-screen sections.
- `m-marquee` keeps one steady direction (`m-reverse` flips it, `m-follow`
  reverses while scrolling up) and loops list items with even spacing.
- Pin spacing is forced on: ScrollTrigger turns it off inside flex parents
  (every Divi 5 section and Elementor container), letting the next section
  slide over the pinned one.

**Builder tooling and docs**

- `tools/divi5.mjs`: `section(..., { video: { mp4, webm } })` sets a native
  background video.
- [DESIGN-STYLES.md](DESIGN-STYLES.md): seven style archetypes from an
  Awwwards study, so a build starts from a named direction.
- [BUILDING.md](BUILDING.md): full-screen sections under a fixed header,
  transparent headers over dark heroes (link colours and a reversed logo),
  background-video overlays; new [KNOWLEDGE.md](KNOWLEDGE.md) entries.

### 1.7.0 — Builder design tooling

From building two redesign concepts on live client sites (Divi 5 and Elementor 4)
to the standard of a hand-built Next.js site. The method is in [BUILDING.md](BUILDING.md).

**Added**

- **`wp_page_screenshot`** (MCP): screenshots a page in a real local browser at
  desktop or mobile width and returns the images, including password-protected
  preview pages, full-page slices and `scroll_to`. Every real defect in those builds
  was invisible in database state and obvious in a screenshot. Uses
  `playwright-core` with the machine's own Chrome/Edge - no browser download.
- **Divi 5 module schema**: `/divi/modules` now reads Divi's own
  `_all_modules_metadata.php`; `?name=` returns a module's attribute paths.
- **`POST /divi/library`** / `wp_divi_library_save`: save a layout to the Divi
  Library, correctly tagged.
- **`GET /elementor/kit`** / `wp_elementor_kit`: the site's global colours and typography.
- **`/elementor/data`**: `page_settings`, `page_template`, `template_type`,
  automatic library tagging, and lint `warnings` for silent render failures.
- **`post_password`** on post create/update, for the safe preview workflow
  (draft → password → noindex → publish).
- `tools/divi5.mjs` and `tools/elementor.mjs`: generators that build builder
  markup from plain JS, escaped exactly as WordPress/Divi write it.
- **Motion for builder pages** (`tools/motion/`): a class-driven runtime on GSAP +
  ScrollTrigger + SplitText (+ Lenis). Put `m-split`, `m-reveal`, `m-stagger`,
  `m-count`, `m-parallax`, `m-clip`, `m-marquee` on native Divi modules or
  Elementor widgets; libraries are self-hosted in uploads and loaded from the
  layout itself, so motion travels with the library template. Content is never
  stuck hidden (3s fail-safe), `prefers-reduced-motion` is respected, and counters
  keep the real figure in the HTML. Tested locally (12 checks) and live.
- [BUILDING.md](BUILDING.md) (now including motion) and fourteen new [KNOWLEDGE.md](KNOWLEDGE.md) entries.

**Fixed**

- The knowledge-base parser skipped every entry in a CRLF (Windows) checkout.
- File writes/fetches into a **new subfolder** of wp-content were refused as
  "outside wp-content": the path check required the direct parent to exist. It
  now checks the nearest existing ancestor and rejects any `..` in the part that
  doesn't exist yet; write/fetch/commit already created missing folders.
- `wp_page_screenshot` no longer downloads video by default (`allow_video` to
  opt in): repeated runs pulling a 20MB+ hero video tripped a shared host's
  per-IP bandwidth throttling.

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
