# Claude Connector — suggested improvements

Portable issue list for the global suggestion file.

Derived from building a 44-page Divi 5 site end to end through the connector in
Admin-AJAX mode: ~500KB of builder markup, 40 media imports, theme options,
taxonomy, a Yoast migration and substantial raw SQL.

**Findings are verified against the source** at `G:\GitHub\claude-connector`
(plugin 1.5.0, matching the version installed on the target site). Line numbers
refer to `claude-connector.php`. Where I could not verify something from the
code I say so.

---

## Priority

| # | Item | Type | Effort | Verified |
|---|------|------|--------|----------|
| 1 | Auth never calls `wp_set_current_user()` → kses destroys builder content | **Data loss** | XS | ✅ code |
| 2 | MCP server / plugin version skew, no handshake | **Silent capability loss** | S | ✅ code |
| 3 | `wp_page_render()` — no way to see the result of a write | Missing tool | M | ✅ absent |
| 4 | `changed_rows` on write queries | Correctness | XS | ✅ code |
| 5 | Bound parameters on `wp_db_query` | Correctness | XS | ✅ code |
| 6 | `wp_divi_data_set` sets 1 of the 5 required Divi 5 meta rows | Correctness | XS | ✅ code |
| 7 | `wp_cache_purge` ignores Divi/Elementor caches | Missing feature | M | ✅ code |
| 8 | `wp_blocks_validate()` | Missing tool | S | ✅ absent |
| 9 | `wp_files_fetch(url, path)` | Missing tool | S | ✅ absent |
| 10 | Dotted-path option access | DX | XS | ✅ code |
| 11 | Document the `args` array and the wp-cli blocklist | **Docs** | XS | ✅ code |
| 12 | Plugin-specific post-write hints (Yoast reindex) | DX | S | ✅ absent |
| 13 | `backup: false` / rotation | DX | XS | ✅ code |

Effort: XS ≈ a few lines · S ≈ one function · M ≈ a small feature.

**Items 1 and 2 are why this build was harder than it needed to be.** Everything
else is incremental.

---

## 1. Auth never sets a current user — this is the kses bug

**Confirmed in code. Highest severity: silent data loss.**

All three transports validate the API key and then dispatch **without ever
establishing a WordPress user**:

- `claude_auth()` — line 223, REST. Returns `true`, no `wp_set_current_user()`.
- `claude_ajax_handler()` — line 1684, Admin-AJAX. Same.
- `claude_enc_handler()` — line 1751, encrypted. Same.

Note both AJAX actions are registered on the `nopriv` variant (lines 1674–1675),
so the request genuinely runs as **user ID 0**.

### Why that destroys Divi/Gutenberg content

`kses_init()` is hooked to `init` in WordPress core and attaches
`wp_filter_post_kses` to `content_save_pre` whenever the current user lacks
`unfiltered_html`. As user 0, that is always true. So every
`wp_insert_post()` / `wp_update_post()` in the plugin runs with kses active and
HTML-escapes block delimiters:

```
<!-- wp:divi/section {...} -->    →    &lt;!-- wp:divi/section {...} --&gt;
```

The call returns 200 with a normal-looking post object. The page then renders the
escaped comment as visible text and the builder can no longer parse the layout.

This affects every content write path, including the purpose-built one:

- `claude_posts_create()` — line 1131
- `claude_posts_update()` — line 1144
- `claude_divi_data_set()` — line 1023
- `claude_elementor_data_set()` — line 918

**I lost the equivalent of a full page of work to this twice**, then routed every
content write for the remaining ~500KB of the build through
`wp_files_write` + `wp_wpcli post update <file> --user=<admin>` instead. That
workaround is the only reason the build completed.

### Second symptom from the same cause

`post_author` defaults to 0 on anything created through `wp_posts_create`, so
posts are authored by a non-existent user. I only avoided this because I was
already using wp-cli with an explicit `--user=`. Anyone using the REST tool as
intended gets orphaned posts.

### The fix

`kses_init` is also hooked to the `set_current_user` action in core, so
establishing the user re-evaluates the filters automatically. Adding this to each
auth path is sufficient:

```php
/**
 * Establish a WordPress user for the request.
 *
 * Without this the request runs as user 0, which means:
 *   - kses is active, so wp_insert_post()/wp_update_post() HTML-escape
 *     Gutenberg and Divi block delimiters and silently destroy layouts;
 *   - post_author defaults to 0 on created posts;
 *   - every capability check behaves as an anonymous visitor.
 *
 * wp_set_current_user() fires the `set_current_user` action, which re-runs
 * kses_init() and removes the kses filters for users holding unfiltered_html.
 */
function claude_assume_user() {
    $user_id = (int) get_option( 'claude_connector_user_id', 0 );

    if ( ! $user_id ) {
        $admins  = get_users( array(
            'role'    => 'administrator',
            'number'  => 1,
            'orderby' => 'ID',
            'fields'  => 'ID',
        ) );
        $user_id = $admins ? (int) $admins[0] : 0;
    }

    if ( ! $user_id ) {
        return new WP_Error( 'cc_no_user', 'No administrator available to run as.' );
    }

    wp_set_current_user( $user_id );

    // Belt and braces: on multisite, administrators do NOT hold unfiltered_html
    // (only super admins do), so kses_init() will have re-attached the filters.
    if ( ! current_user_can( 'unfiltered_html' ) ) {
        kses_remove_filters();
    }

    return $user_id;
}
```

Call it immediately after the key check in all three handlers.

Expose the user as a setting (`claude_connector_user_id`) on the options page so
the site owner controls which account the connector acts as. That is better
practice than picking the lowest-numbered admin, and it makes the access log
meaningful.

**The multisite branch matters** — `map_meta_cap` strips `unfiltered_html` from
ordinary administrators on multisite, so `wp_set_current_user()` alone would not
fix the bug there.

### Add a post-write canary so this can never regress silently

```php
$written = get_post_field( 'post_content', $post_id );
if ( false !== strpos( $written, '&lt;!-- wp:' ) ) {
    return new WP_Error(
        'cc_block_corruption_detected',
        'Block delimiters were escaped during write. The request is running '
        . 'without unfiltered_html capability.',
        array( 'status' => 500 )
    );
}
```

### Audit query for installs already affected

```sql
SELECT ID, post_title FROM wp_posts WHERE post_content LIKE '%&lt;!--%';
```

I ran that variant as a standing check after every batch of writes for the whole
build. It should not be the user's job.

---

## 2. MCP server / plugin version skew, with no handshake

**Confirmed in code. This one is a bit painful.**

| Component | Version | Tools |
|---|---|---|
| Plugin on the site | 1.5.0 | — |
| `mcp-server/index.js` in the repo | 1.5.0 | 36 |
| The MCP server my session actually loaded | **1.1.0** | **23** |

The project's `.mcp.json` points at a copy kept outside the repo
(`C:/Users/Wisnu/claude-sites/.mcp-server/index.js`), which was four minor
versions behind. Thirteen tools were missing, including all three Divi tools:

```
wp_divi_modules_list   wp_divi_data_get   wp_divi_data_set
wp_elementor_*         wp_acf_fields_*    wp_acf_options_*
wp_acf_group_export    wp_knowledge_*
```

**So I built an entire Divi 5 site without the Divi tools**, and had no way to
know they existed. I discovered them only by reading this repo afterwards.

Nothing warns about this. The MCP server reports `version: '1.5.0'` in its own
handshake string (hardcoded, line 151) but never compares itself against the
plugin, and `/status` doesn't return the plugin version in a form the server
checks.

### The fix

Have the MCP server fetch the plugin version at startup and compare:

```js
const PROTOCOL_VERSION = '1.5.0';

const status = await api('GET', '/status');
if (status.plugin_version !== PROTOCOL_VERSION) {
  console.error(
    `[claude-connector] Version mismatch: MCP server ${PROTOCOL_VERSION}, ` +
    `plugin ${status.plugin_version}. Some tools may be missing or may not ` +
    `match the plugin's endpoints. Update whichever is older.`
  );
}
```

Then surface it in `wp_status` output too, so it is visible in-session rather
than only on stderr — a warning printed at startup is easy to never see.

**Also worth doing:** `setup.js` appears to install the MCP server to a shared
path. If it does, make it overwrite/upgrade an existing install rather than
leaving a stale copy, and note the install path in the README so a stale server
is diagnosable.

---

## 3. `wp_page_render(id_or_url)` — no way to observe a write

**Confirmed absent.** Every tool returns database state. None returns what a
browser sees.

Confirmed defects from this build that were **completely invisible** from
`post_content`:

- Divi's generated per-module CSS had indices offset by each page's module count
  — the stylesheet targeted `.et_pb_text_0` while the markup rendered
  `.et_pb_text_12`, so no attribute styling applied on any page, sitewide. See
  item 7.
- A page rendering on the wrong template (item 6): two `<h1>`s and a widget
  sidebar.
- kses corruption (item 1).
- Mismatched heading tags inherited from migrated content.
- Hero padding correct on desktop, badly wrong on phone, because the header
  template switches `fixed` → `relative` at 767px.

I fell back on `curl` plus a local headless Chromium. Server-side rendering is
strictly better: no auth or caching differences, and it works for clients with
no browser available.

```php
function claude_page_render( $req ) {
    $id  = $req->get_param( 'id' );
    $url = $id ? get_permalink( (int) $id ) : (string) $req->get_param( 'url' );
    if ( ! $url ) {
        return new WP_Error( 'missing', 'Provide id or url.', array( 'status' => 400 ) );
    }

    $res = wp_remote_get( add_query_arg( 'cc_cb', time(), $url ), array(
        'timeout'    => 30,
        'sslverify'  => false,   // staging hosts often have self-signed certs
        'cookies'    => array(), // render as an anonymous visitor
        'user-agent' => 'ClaudeConnector/1.5',
    ) );
    if ( is_wp_error( $res ) ) {
        return new WP_Error( 'loopback_failed',
            'Could not fetch the page server-side. The host may block loopback HTTP. '
            . $res->get_error_message(), array( 'status' => 502 ) );
    }

    $html = wp_remote_retrieve_body( $res );

    return new WP_REST_Response( array(
        'http'    => wp_remote_retrieve_response_code( $res ),
        'summary' => claude_render_summary( $html ),
        'html'    => $req->get_param( 'include_html' ) ? $html : null,
    ) );
}

function claude_render_summary( $html ) {
    return array(
        'title'            => preg_match( '/<title>(.*?)<\/title>/is', $html, $m ) ? trim( $m[1] ) : null,
        'meta_description' => preg_match( '/name=["\']description["\']\s+content=["\'](.*?)["\']/is', $html, $m ) ? $m[1] : null,
        'h1_count'         => preg_match_all( '/<h1[\s>]/i', $html ),
        'sections'         => preg_match_all( '/et_pb_section[\s"\']/', $html ),
        'empty_paragraphs' => preg_match_all( '/<p>\s*<\/p>/', $html ),
        'kses_corruption'  => (bool) preg_match( '/&lt;!--\s*wp:/', $html ),
        'has_sidebar'      => (bool) preg_match( '/id=["\']sidebar["\']/', $html ),
        'bytes'            => strlen( $html ),
    );
}
```

**Default to `summary` only** — a rendered Divi page is 100KB+ and the summary is
usually the whole answer. Explicitly detect and report a blocked loopback rather
than returning an opaque error.

**Nice extension:** `expect` assertions, so verification is one call:

```
wp_page_render({ id: 391, expect: { h1_count: 1, has_sidebar: false } })
→ { ok: false, failed: ["h1_count: expected 1, got 2", "has_sidebar: expected false, got true"] }
```

---

## 4. `changed_rows` on write queries

**Confirmed in code**, `claude_db_query()` line 1533:

```php
return new WP_REST_Response( array(
    'result'     => $result,
    'rows'       => is_array( $result ) ? count( $result ) : null,
    'last_query' => $wpdb->last_query,
) );
```

For `type: "query"`, `$result` is `$wpdb->query()`'s return value — **rows
matched**, not rows changed — and `rows` is `null`. Actual returns I saw:

| Statement | `result` | The ambiguity |
|---|---|---|
| `UPDATE … REPLACE(...) WHERE ID = 44` | `1` | matched one row, but did the REPLACE find its needle? |
| `INSERT … SELECT … CROSS JOIN` | `65` | unambiguous (rows inserted) |
| `DELETE … WHERE meta_key IN (…)` | `0` | matched nothing, or deleted nothing? |

The `UPDATE` case is the problem: `1` covers both "changed successfully" and
"matched the row but changed nothing". Completely different outcomes, and this
is the **normal** case for any `REPLACE()`-based content edit.

Combined with item 5, a mis-escaped query is indistinguishable from a successful
one. I wrote a separate verification `SELECT` after every single write for the
whole build because of this.

```php
$changed = null;
if ( isset( $wpdb->dbh ) && $wpdb->dbh instanceof mysqli ) {
    // e.g. "Rows matched: 1  Changed: 0  Warnings: 0"
    if ( preg_match( '/Changed: (\d+)/', (string) mysqli_info( $wpdb->dbh ), $m ) ) {
        $changed = (int) $m[1];
    }
}

return new WP_REST_Response( array(
    'result'        => $result,
    'rows'          => is_array( $result ) ? count( $result ) : null,
    'affected_rows' => is_int( $result ) ? $result : null,
    'changed_rows'  => $changed,
    'insert_id'     => $wpdb->insert_id ?: null,
    'last_query'    => $wpdb->last_query,
) );
```

---

## 5. Bound parameters on `wp_db_query`

**Confirmed in code** — the query string goes straight to `$wpdb` with no
`prepare()` path available.

Divi 5 stores block attributes as JSON *inside* `post_content`, so the column
literally contains `\"`. Matching that through the JSON tool envelope requires
`\\"`, and `last_query` echoes it back as `\\\\"`. Three levels of escaping, by
hand, on statements that modify live content.

A real query from this build:

```sql
UPDATE wp_posts SET post_content = REPLACE(post_content,
  '<div class=\\"afl-topic\\"><img class=\\"afl-topic-img\\" src=\\"...-12.jpg\\"',
  '<a class=\\"afl-topic\\" href=\\"...\\"><img class=\\"afl-topic-img\\" src=\\"...-12.jpg\\"')
WHERE ID = 44
```

The fix is essentially one line:

```php
if ( ! empty( $body['params'] ) && is_array( $body['params'] ) ) {
    $query = $wpdb->prepare( $query, $body['params'] );
}
```

Caller-side, one level of escaping instead of three:

```json
{
  "query":  "UPDATE wp_posts SET post_content = REPLACE(post_content, %s, %s) WHERE ID = %d",
  "params": ["<div class=\"afl-topic\">", "<a class=\"afl-topic\">", 44]
}
```

**Also worth adding: `dry_run: true`.** The existing `confirm_destructive` guard
(line ~1548) is a good idea; a rehearsal mode is its natural companion, since
chained `REPLACE()` updates are exactly the case where you want to see the
result before committing:

```php
$wpdb->query( 'START TRANSACTION' );
$affected = $wpdb->query( $query );
$changed  = claude_changed_rows( $wpdb );
$wpdb->query( ! empty( $body['dry_run'] ) ? 'ROLLBACK' : 'COMMIT' );
```

InnoDB only — say so in the response when the engine can't support it.

---

## 6. `wp_divi_data_set` sets 1 of the 5 required Divi 5 meta rows

**Confirmed in code**, `claude_divi_data_set()` line 1023:

```php
update_post_meta( $post_id, '_et_pb_use_builder', 'on' );
if ( defined( 'ET_BUILDER_PRODUCT_VERSION' ) ) {
    update_post_meta( $post_id, '_et_builder_version', ET_BUILDER_PRODUCT_VERSION );
}
```

For **Divi 5** a page needs five rows or it renders on the theme's default
template — widget sidebar, duplicated title, no builder layout. The content is
perfect; the page looks broken:

```
_et_pb_use_builder   = on      ← the only one currently set
_et_pb_use_divi_5    = on
_et_pb_page_layout   = et_no_sidebar
_et_pb_side_nav      = off
_et_pb_post_hide_nav = default
```

I hit this twice on this build — once for a whole batch of new pages, once for a
single page I missed, which then sat quietly broken until a rendered-page check
caught two `<h1>`s and a `#sidebar` on it.

`claude_divi_generation()` already detects `d4_shortcode` vs `d5_json`, so the
branch is easy:

```php
update_post_meta( $post_id, '_et_pb_use_builder', 'on' );

if ( 'd5_json' === claude_divi_generation() ) {
    update_post_meta( $post_id, '_et_pb_use_divi_5', 'on' );
    // Only set layout defaults on create, so an existing page's choices survive.
    foreach ( array(
        '_et_pb_page_layout'   => 'et_no_sidebar',
        '_et_pb_side_nav'      => 'off',
        '_et_pb_post_hide_nav' => 'default',
    ) as $k => $v ) {
        if ( '' === (string) get_post_meta( $post_id, $k, true ) ) {
            update_post_meta( $post_id, $k, $v );
        }
    }
}
```

**Also infer it in `claude_posts_create()`** for people who don't know the Divi
tool exists (which, per item 2, was me):

```php
if ( false !== strpos( (string) ( $data['post_content'] ?? '' ), '<!-- wp:divi/' ) ) {
    // apply the same meta, and note it in the response
    $response['notes'][] = 'Detected Divi 5 blocks; applied builder postmeta.';
}
```

**And an audit endpoint** — five lines, would have caught both of my incidents:

```php
function claude_builder_audit() {
    global $wpdb;
    return $wpdb->get_results( "
        SELECT p.ID, p.post_name, p.post_type
        FROM {$wpdb->posts} p
        LEFT JOIN {$wpdb->postmeta} m
               ON m.post_id = p.ID AND m.meta_key = '_et_pb_use_builder'
        WHERE p.post_content LIKE '%<!-- wp:divi/%'
          AND p.post_status = 'publish'
          AND m.meta_id IS NULL
    ", ARRAY_A );
}
```

---

## 7. `wp_cache_purge` ignores Divi and Elementor

**Confirmed in code**, `claude_cache_purge()` line 1035. It covers object cache,
transients, WP Engine, W3TC, Super Cache, WP Rocket and LiteSpeed — but has no
builder handling at all, despite the plugin shipping dedicated Divi and Elementor
endpoints. (`grep -c "et-cache\|divi_dynamic"` → 0.)

Divi caches per-post CSS in `wp-content/et-cache/<id>/` and in
`_divi_dynamic_assets_cached_*` postmeta. Raw SQL edits bypass every WordPress
hook, so neither is invalidated — the page serves stale styles and you conclude
your edit didn't work.

### The severe case, which cost me the most time in the whole build

Installing a plugin (Yoast) invalidated Divi's caches, and **the regeneration
came out wrong**: per-module CSS indices were offset by each page's module count,
so the stylesheet targeted `.et_pb_text_0` while the markup rendered
`.et_pb_text_12`. Every Divi-attribute style on every page stopped applying,
sitewide. Nothing in the database had changed.

The client's report was "some pages have weird styling, text hard to read", then
"the pages look bad now, it was good and fine before". The only remedy is to
re-save every builder post, which forces clean regeneration.

Any Divi user of this plugin will eventually hit this. The knowledge belongs in
the plugin.

```php
function claude_cache_purge( $req = null ) {
    $opts   = $req ? (array) $req->get_json_params() : array();
    $purged = array();

    /* … existing object cache / transient / host-cache handling … */

    if ( ! empty( $opts['builder'] ) ) {
        global $wpdb;

        if ( class_exists( 'ET_Core_PageResource' ) ) {
            ET_Core_PageResource::remove_static_resources( 'all', 'all' );
            $purged[] = 'divi_static_resources';
        }
        if ( function_exists( 'et_core_clear_wp_cache' ) ) {
            et_core_clear_wp_cache();
        }
        $wpdb->query( "DELETE FROM {$wpdb->postmeta}
                       WHERE meta_key LIKE '_divi_dynamic_assets_cached%'" );
        $purged[] = 'divi_dynamic_assets_meta';

        if ( class_exists( '\Elementor\Plugin' ) ) {
            \Elementor\Plugin::$instance->files_manager->clear_cache();
            $purged[] = 'elementor_css';
        }
    }

    // Divi regenerates per-module CSS on save. After a raw SQL edit, or after
    // any plugin install/update, regeneration can emit module indices that do
    // not match the rendered markup until each post is re-saved.
    if ( ! empty( $opts['resave_builder_posts'] ) ) {
        $ids = $wpdb->get_col( "
            SELECT ID FROM {$wpdb->posts}
            WHERE post_status = 'publish'
              AND ( post_content LIKE '%<!-- wp:divi/%'
                 OR post_content LIKE '%[et_pb_section%' )
        " );
        foreach ( $ids as $id ) {
            wp_update_post( array( 'ID' => (int) $id ) );
        }
        $purged[] = 'resaved:' . count( $ids );
    }

    return new WP_REST_Response( array( 'purged' => $purged ) );
}
```

### Documentation asks — sequences that are not guessable

- *After a raw SQL edit to `post_content`:* delete
  `_divi_dynamic_assets_cached_*`, **re-save the post**, then purge. The re-save
  is the load-bearing step; deleting the meta alone is not enough.
- *After installing or updating any plugin on a Divi site:* re-save every
  builder page, then check that every `.et_pb_<type>_<n>` selector in the
  generated CSS actually exists in the rendered markup.
- *Leave `divi_dynamic_module_framework`, `divi_critical_css` and
  `divi_defer_block_css` ON.* Turning them off to simplify the CSS pipeline
  broke the navigation and dropped hero background images.

---

## 8. `wp_blocks_validate(post_id)`

**Confirmed absent.** Malformed block markup fails silently — Divi 5 content is
JSON inside HTML comments, and one unbalanced brace corrupts a page with no
parse error, only a rendering oddity.

I wrote a local validator (count block opens vs closes, `JSON.parse` every
attribute blob) and ran it on every file before upload. That's a local
approximation of something WordPress does natively and better.

```php
function claude_blocks_validate( $req ) {
    $post_id = (int) $req['id'];
    $content = get_post_field( 'post_content', $post_id );
    if ( ! is_string( $content ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }

    $blocks = parse_blocks( $content );
    $issues = array();

    if ( false !== strpos( $content, '&lt;!-- wp:' ) ) {
        $issues[] = array( 'type' => 'kses_corruption', 'fatal' => true );
    }

    // Invalid attribute JSON makes parse_blocks() drop attrs, so the round trip
    // stops matching. Strong builder-agnostic canary for malformed markup.
    if ( trim( serialize_blocks( $blocks ) ) !== trim( $content ) ) {
        $issues[] = array(
            'type' => 'round_trip_mismatch',
            'hint' => 'Likely invalid attribute JSON in one or more blocks',
        );
    }

    $walk = function ( $bs, $path ) use ( &$walk, &$issues ) {
        foreach ( $bs as $i => $b ) {
            if ( null === $b['blockName'] && '' !== trim( $b['innerHTML'] ) ) {
                $issues[] = array(
                    'type'    => 'unparsed_or_freeform',
                    'path'    => "$path/$i",
                    'excerpt' => substr( trim( $b['innerHTML'] ), 0, 120 ),
                );
            }
            if ( ! empty( $b['innerBlocks'] ) ) {
                $walk( $b['innerBlocks'], "$path/$i" );
            }
        }
    };
    $walk( $blocks, '' );

    return new WP_REST_Response( array(
        'block_count' => count( $blocks ),
        'valid'       => empty( $issues ),
        'issues'      => $issues,
    ) );
}
```

The `serialize_blocks()` round-trip comparison is the cheap high-value check.

**Best of all: run it automatically after every content write** and include the
result in the response. Then malformed markup can never be written silently —
which, together with item 1, closes the whole silent-corruption category.

---

## 9. `wp_files_fetch(url, path)`

**Confirmed absent.** There is a `content_b64` parameter (line 1383) and a
`files_stage` / `files_commit` chunked path (lines 1420, 1455) — but the comments
make clear both exist to get *past WAFs*, not to reduce transfer. The bytes still
flow through the model either way. (`files_stage` also wasn't in my MCP version,
per item 2.)

**Impact.** Every byte of generated content round-trips through the model's
context — twice, if generated locally (read out, then write back). The final
batch of 13 pages was 112KB of markup, so ~224KB of transfer for work a 5KB
server-side script could have done. It scales linearly with page count and it is
the dominant cost of a large build.

The capability plainly exists: `wp media import <url>` pulled 40 images from a
third-party domain without complaint. It just isn't exposed for files.

```php
function claude_files_fetch( $req ) {
    $body = (array) $req->get_json_params();
    $url  = (string) ( $body['url'] ?? '' );
    $rel  = (string) ( $body['path'] ?? '' );

    if ( ! $url || ! $rel ) {
        return new WP_Error( 'missing', 'Body must include "url" and "path".', array( 'status' => 400 ) );
    }

    $path = claude_safe_path( $rel );   // reuse the existing guard
    if ( ! $path ) {
        return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );
    }

    require_once ABSPATH . 'wp-admin/includes/file.php';
    $tmp = download_url( $url, (int) ( $body['timeout'] ?? 60 ) );
    if ( is_wp_error( $tmp ) ) return $tmp;

    $max = (int) ( $body['max_bytes'] ?? 20 * MB_IN_BYTES );
    if ( filesize( $tmp ) > $max ) {
        @unlink( $tmp );
        return new WP_Error( 'too_large', 'Exceeds max_bytes.', array( 'status' => 413 ) );
    }

    // Run the same syntax guard as files_write.
    if ( $lint = claude_php_lint( file_get_contents( $tmp ), $rel ) ) {
        @unlink( $tmp );
        return new WP_Error( 'php_syntax_error', $lint, array( 'status' => 422 ) );
    }

    wp_mkdir_p( dirname( $path ) );
    $backup = claude_backup_file( $path );
    if ( ! @rename( $tmp, $path ) ) {
        @unlink( $tmp );
        return new WP_Error( 'write_failed', 'Could not write file.', array( 'status' => 500 ) );
    }

    return new WP_REST_Response( array(
        'written' => $rel,
        'bytes'   => filesize( $path ),
        'sha256'  => hash_file( 'sha256', $path ),  // verify without reading it back
        'backup'  => $backup ? ltrim( str_replace( WP_CONTENT_DIR, '', $backup ), '/\\' ) : null,
    ) );
}
```

Returning `sha256` is worth it — the caller can confirm the transfer without
spending context on a read-back.

**Cheaper partial win if a fetcher is unwelcome:** an `append: true` flag on
`files_write`, so incremental edits don't re-send the whole file. I split my
stylesheet into five files partly for organisation and partly so a one-line
tweak didn't mean re-uploading 20KB.

---

## 10. Dotted-path option access

**Confirmed in code** — `claude_options_get()` is a flat `get_option( $key )`
with a blocklist.

`wp_options_get({key: "divi_integration_head"})` returns `false`, because Divi
stores that key *inside* the serialised `et_divi` array rather than as its own
option row. I found it with a raw `LIKE` against `wp_options`.

Reading one string then meant `wp option get et_divi --format=json` — a ~12KB
blob returned every time, just to check a cache-busting version number. I did
that repeatedly across the build.

The write path is already fine:
`wp option patch update et_divi divi_integration_head "<value>"` works
correctly, including embedded newlines and quotes via the `args` array.

```php
function claude_option_path_get( $key ) {
    if ( false === strpos( $key, '.' ) ) {
        return get_option( $key );
    }
    $parts = explode( '.', $key );
    $root  = array_shift( $parts );

    if ( in_array( $root, claude_blocked_options(), true ) ) {
        return new WP_Error( 'blocked', "Option '{$root}' is protected.", array( 'status' => 403 ) );
    }

    $value = get_option( $root );
    foreach ( $parts as $p ) {
        if ( is_array( $value ) && array_key_exists( $p, $value ) ) {
            $value = $value[ $p ];
        } elseif ( is_object( $value ) && isset( $value->$p ) ) {
            $value = $value->$p;
        } else {
            return null;   // distinguishes "missing" from a literal false
        }
    }
    return $value;
}
```

Note the blocklist has to be checked against the **root** key, not the full
dotted path, or it's trivially bypassed.

**Related, cheap:** `wp_options_search(pattern)` that greps option names **and**
values, returning names plus a matched excerpt rather than whole blobs. Most of
my discovery work was
`SELECT option_name FROM wp_options WHERE option_value LIKE '%…%'`.

---

## 11. Document the `args` array and the wp-cli blocklist

**Docs only, and the highest value-per-word change available.**

**a) `wp_wpcli` has two calling conventions with very different behaviour.**
`command` (a single string) goes through shell quoting and breaks on anything
containing quotes, newlines or `$`. The `args` array bypasses all of it — I
passed 20KB of HTML as a single `--post_content=…` argument with embedded quotes
and newlines and it worked perfectly.

That difference is what made this build possible, and the tool description
doesn't mention it. Suggested wording:

> Prefer `args` (array) over `command` (string) for anything containing quotes,
> newlines, `$` or other shell metacharacters. `args` is passed directly to the
> process and skips shell interpretation entirely.

**b) The blocklist is invisible until you trip it.** From line 1915:

```php
$blocked_top = array( 'shell', 'server', 'eval', 'eval-file', 'package' );
```

I discovered `wp eval` was blocked by running it and getting a 400. Please list
the blocked top-level commands and subcommands in the tool description.

**Worth reconsidering the `eval` policy.** The comment at line 1912 says "use the
REST API instead", but the REST API cannot do a bulk transform — and on a host
where the connector already has full DB and file-write access, blocking `eval`
adds little real security (you can write a PHP file into `wp-content` and
include it). What it does do is force every byte through the model, which is
item 9. A per-site opt-in setting would be a reasonable middle ground.

If `eval` stays blocked, a narrow allowlisted alternative would cover most bulk
work:

```php
const CLAUDE_ALLOWED_CALLS = array(
    'wp_insert_post', 'wp_update_post', 'wp_delete_post',
    'update_post_meta', 'delete_post_meta',
    'wp_set_object_terms', 'wp_insert_term', 'media_sideload_image',
);
```

with a `repeat` parameter that runs the call once per element — turning "set five
meta rows on thirteen pages" from 65 round trips into one.

---

## 12. Plugin-specific post-write hints

**Confirmed absent.** Plugins with their own cache layers don't see direct
postmeta writes. Yoast is the clearest case: it serves from
`wp_yoast_indexable`, so `_yoast_wpseo_title` / `_yoast_wpseo_metadesc` written
via SQL **do not render at all** until:

```
wp yoast index --reindex --skip-confirmation
```

Before I found that, titles silently fell back to the template and descriptions
came out empty, with correct values sitting in the database. Very easy to
misdiagnose as a failed write.

Detect known meta-key prefixes and return a hint — even just the hint would have
saved the diagnosis:

```php
$hints = array(
    '_yoast_wpseo_' => 'wp yoast index --reindex --skip-confirmation',
    '_aioseo_'      => 'AIOSEO caches separately; a rescan is required',
    'rank_math_'    => 'wp rankmath sitemap generate',
);
foreach ( $hints as $prefix => $hint ) {
    if ( 0 === strpos( $meta_key, $prefix ) ) {
        $response['follow_up'][] = $hint;
    }
}
```

---

## 13. `backup: false` / rotation

`claude_backup_file()` is **good** and saved me once —
`backup: "uploads/afl-hero.css.20260914015057.bak"` on overwrite, `null` on
create. Keep it.

They accumulate, though: several edits to one stylesheet left several `.bak`
files I then deleted individually. Add `backup: false`, or cap retention per
path (keep the newest N).

---

## What's already right — don't regress these

Reading the source, several things are better than I assumed while using it:

- **`wp_slash()` is handled correctly** on every write path (lines 915, 1023,
  1131, 1144), *with* an explanatory comment about `wp_unslash()` and literal
  backslashes. I had this on my list as a suspected bug; it isn't one. Divi 5's
  escaped JSON survives intact. Good catch by whoever wrote that comment — it's
  a subtle failure mode.
- **`claude_php_lint()` before writing a file** (line 1399) is excellent. A
  syntax check that prevents white-screening the site is exactly the right guard
  in a tool an agent drives.
- **`claude_safe_path()`** confining writes to `wp-content`. Reasonable, and the
  right default.
- **`confirm_destructive` on `wp_db_query`** for `DROP` / `TRUNCATE` /
  `DELETE`-without-`WHERE` (line ~1548). Good instinct; extend it with `dry_run`
  (item 5).
- **`readonly` mode on `wp_db_query`.** Useful, and worth surfacing more
  prominently as the default for exploration.
- **`wp_wpcli` with the `args` array.** The workhorse of the entire build. Just
  document it (item 11).
- **Auth rate limiting** — 10 failures per IP per 5 minutes, with the counter
  cleared on success. Well judged.
- **`wp_cache_purge` reporting what it purged.** Good pattern; extend the
  coverage (item 7) and keep the reporting.
- **`wp media import` with multiple URLs.** 40 images, four calls, no issues.
- **Three transports (REST / AJAX / AES-GCM) for WAF-hostile hosts.** This is
  thoughtful, real-world engineering. The encrypted mode in particular is not
  something I'd have expected to find.

---

## Recipe worth adding to the README

**Migrating from another WordPress site via its REST API.** The source site
exposed `/wp-json/wp/v2/pages?per_page=100` and `/posts`, which gave exact
structured content for 61 pages and 35 posts — no HTML scraping, no guesswork.
Reading from that and writing through the connector is a clean, repeatable
migration path that isn't obvious until you've tried it.

A `wp_remote_import(url)` that reads another install's REST API server-side
would make this first-class, and it composes naturally with `wp_files_fetch`
(item 9).

---

## Meta feedback

Ranked by how much they'd change day-to-day use:

1. **Silent failure is the recurring theme, and it has one root cause.** kses
   corruption, `post_author = 0`, orphaned capability checks — items 1, 4, 6 and
   8 are all the same underlying problem surfacing in different places: the
   request has no user, and the response doesn't report what actually happened.
   Fixing item 1 and adding the item 8 canary would close most of it for a
   day's work.
2. **The plugin can write but not observe.** It's a complete authoring API with
   no read-back of the result. Item 3 closes the loop and turns a
   guess-and-check workflow into verify-then-proceed.
3. **Version skew silently removes capability.** I did the entire build unaware
   that three Divi-specific tools existed (item 2). A startup version check is
   half an hour of work and would have changed how this project went.
4. **Tool descriptions are load-bearing.** `args` vs `command` determines
   whether large writes are possible at all, and it isn't discoverable. Same for
   the kses limitation and the wp-cli blocklist. A few sentences in the right
   descriptions are worth more than most new features here.
5. **Builder-awareness is the main domain gap.** The plugin already has Divi and
   Elementor endpoints, so the intent is there — but the cache layer (item 7) and
   the Divi 5 meta set (item 6) haven't caught up with it. Those two plus item 8
   would make it genuinely builder-competent rather than builder-adjacent.
