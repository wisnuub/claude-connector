<?php
/**
 * Plugin Name:  Claude Connector
 * Plugin URI:   https://github.com/wisnuub/claude-connector
 * Description:  Secure REST API bridge for Claude AI - ACF sync, cache purge, file management, database queries, post CRUD, plugin/theme control, maintenance updates with rollback, and more.
 * Version:      1.8.16
 * Author:       Wisnuub
 * Author URI:   https://wisnuub.github.io
 * License:      GPL-2.0-or-later
 * License URI:  https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:  claude-connector
 * Requires PHP: 7.4
 * Requires WP:  5.8
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'CLAUDE_CONNECTOR_VERSION', '1.8.16' );
define( 'CLAUDE_CONNECTOR_NS',      'claude/v1' );
define( 'CLAUDE_CONNECTOR_GH_REPO', 'wisnuub/claude-connector' );

/**
 * Postmeta a Divi 5 page needs in order to render through the builder.
 *
 * Without the full set WordPress falls back to the theme's default template,
 * which shows the widget sidebar and a duplicated theme title. The page looks
 * broken even though post_content is perfect, and the cause is not obvious
 * from the database.
 *
 * _et_pb_use_builder is required for every Divi generation; the rest are
 * Divi 5 layout defaults.
 */
define( 'CLAUDE_DIVI5_META', array(
    '_et_pb_use_builder'   => 'on',
    '_et_pb_use_divi_5'    => 'on',
    '_et_pb_page_layout'   => 'et_no_sidebar',
    '_et_pb_side_nav'      => 'off',
    '_et_pb_post_hide_nav' => 'default',
) );

// PHP 7.x polyfills ────────────────────────────────────────────────────────────
if ( ! function_exists( 'str_starts_with' ) ) {
    function str_starts_with( string $haystack, string $needle ): bool {
        return $needle === '' || strncmp( $haystack, $needle, strlen( $needle ) ) === 0;
    }
}
if ( ! function_exists( 'str_ends_with' ) ) {
    function str_ends_with( string $haystack, string $needle ): bool {
        return $needle === '' || substr( $haystack, -strlen( $needle ) ) === $needle;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
//  GitHub-based auto-updates
//
//  No wordpress.org listing, so WP's normal update check is hooked manually:
//  poll the GitHub Releases API, compare tags against CLAUDE_CONNECTOR_VERSION,
//  and point WP's upgrader at the release's `claude-connector.zip` asset.
// ──────────────────────────────────────────────────────────────────────────────

function claude_connector_basename() {
    return plugin_basename( __FILE__ );
}

/**
 * Fetches (and caches for 12h) the latest published GitHub release.
 *
 * @return array{version:string,zip_url:string,notes:string,url:string}
 */
function claude_connector_get_latest_release() {
    $cached = get_transient( 'claude_connector_gh_release' );
    if ( is_array( $cached ) ) {
        return $cached;
    }

    $response = wp_remote_get( 'https://api.github.com/repos/' . CLAUDE_CONNECTOR_GH_REPO . '/releases/latest', array(
        'headers' => array( 'Accept' => 'application/vnd.github+json' ),
        'timeout' => 10,
    ) );

    $release = array( 'version' => '', 'zip_url' => '', 'notes' => '', 'url' => '' );

    if ( ! is_wp_error( $response ) && wp_remote_retrieve_response_code( $response ) === 200 ) {
        $data = json_decode( wp_remote_retrieve_body( $response ), true );

        if ( ! empty( $data['tag_name'] ) ) {
            $zip_url = '';
            foreach ( (array) ( $data['assets'] ?? array() ) as $asset ) {
                if ( ( $asset['name'] ?? '' ) === 'claude-connector.zip' ) {
                    $zip_url = $asset['browser_download_url'];
                    break;
                }
            }

            $release = array(
                'version' => ltrim( $data['tag_name'], 'v' ),
                // Fall back to GitHub's auto-generated zipball if a release has no
                // uploaded asset; upgrader_source_selector() below fixes its folder name.
                'zip_url' => $zip_url ?: ( $data['zipball_url'] ?? '' ),
                'notes'   => $data['body'] ?? '',
                'url'     => $data['html_url'] ?? '',
            );
        }
    }

    // Cache successes for 12h, failures for 15m so a GitHub outage doesn't spam requests.
    set_transient( 'claude_connector_gh_release', $release, $release['version'] ? 12 * HOUR_IN_SECONDS : 15 * MINUTE_IN_SECONDS );
    return $release;
}

add_filter( 'pre_set_site_transient_update_plugins', 'claude_connector_check_for_update' );
function claude_connector_check_for_update( $transient ) {
    if ( empty( $transient->checked ) ) {
        return $transient;
    }

    $release = claude_connector_get_latest_release();
    if ( ! $release['version'] || ! $release['zip_url'] ) {
        return $transient;
    }

    if ( version_compare( $release['version'], CLAUDE_CONNECTOR_VERSION, '>' ) ) {
        $plugin_slug = claude_connector_basename();
        $transient->response[ $plugin_slug ] = (object) array(
            'slug'        => 'claude-connector',
            'plugin'      => $plugin_slug,
            'new_version' => $release['version'],
            'url'         => $release['url'] ?: ( 'https://github.com/' . CLAUDE_CONNECTOR_GH_REPO ),
            'package'     => $release['zip_url'],
            'tested'      => get_bloginfo( 'version' ),
        );
    }

    return $transient;
}

add_filter( 'plugins_api', 'claude_connector_plugins_api', 20, 3 );
function claude_connector_plugins_api( $result, $action, $args ) {
    if ( $action !== 'plugin_information' || empty( $args->slug ) || $args->slug !== 'claude-connector' ) {
        return $result;
    }

    $release = claude_connector_get_latest_release();
    if ( ! $release['version'] ) {
        return $result;
    }

    return (object) array(
        'name'          => 'Claude Connector',
        'slug'          => 'claude-connector',
        'version'       => $release['version'],
        'author'        => '<a href="https://wisnuub.github.io">Wisnuub</a>',
        'homepage'      => 'https://github.com/' . CLAUDE_CONNECTOR_GH_REPO,
        'download_link' => $release['zip_url'],
        'sections'      => array(
            'description' => 'Secure REST API bridge for Claude AI - ACF sync, cache purge, file management, database queries, post CRUD, plugin/theme control, and more.',
            'changelog'   => wpautop( wp_kses_post( $release['notes'] ) ),
        ),
    );
}

/**
 * GitHub's auto-generated zipball (used when a release has no uploaded asset)
 * extracts to "claude-connector-<tag>/". Rename it back to "claude-connector/"
 * so the upgrader replaces the existing plugin folder instead of leaving a
 * stale duplicate next to it - same class of bug as the manual-zip-upload issue.
 */
add_filter( 'upgrader_source_selector', 'claude_connector_fix_source_dir', 10, 4 );
function claude_connector_fix_source_dir( $source, $remote_source, $upgrader, $hook_extra ) {
    global $wp_filesystem;

    if ( empty( $hook_extra['plugin'] ) || $hook_extra['plugin'] !== claude_connector_basename() || ! $wp_filesystem ) {
        return $source;
    }

    $desired = trailingslashit( $remote_source ) . 'claude-connector/';
    if ( trailingslashit( $source ) === $desired ) {
        return $source;
    }

    return $wp_filesystem->move( $source, $desired ) ? $desired : $source;
}

add_action( 'upgrader_process_complete', 'claude_connector_clear_update_cache', 10, 2 );
function claude_connector_clear_update_cache( $upgrader, $hook_extra ) {
    if ( ( $hook_extra['action'] ?? '' ) === 'update'
        && ( $hook_extra['type'] ?? '' ) === 'plugin'
        && in_array( claude_connector_basename(), (array) ( $hook_extra['plugins'] ?? array() ), true )
    ) {
        delete_transient( 'claude_connector_gh_release' );
    }
}

// ──────────────────────────────────────────────────────────────────────────────
//  API Key helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns the active API key.
 * Pin permanently via wp-config.php: define( 'CLAUDE_API_KEY', '...' );
 *
 * @return string
 */
function claude_get_api_key() {
    if ( defined( 'CLAUDE_API_KEY' ) && CLAUDE_API_KEY !== '' ) {
        return CLAUDE_API_KEY;
    }
    $key = get_option( 'claude_connector_api_key', '' );
    if ( ! $key ) {
        $key = bin2hex( random_bytes( 32 ) ); // 64-char hex, 256-bit entropy
        update_option( 'claude_connector_api_key', $key, false );
    }
    return $key;
}

/**
 * Returns the real client IP, preferring Cloudflare header when present.
 *
 * @return string
 */
function claude_get_request_ip() {
    foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $k ) {
        if ( ! empty( $_SERVER[ $k ] ) ) {
            return sanitize_text_field( trim( explode( ',', $_SERVER[ $k ] )[0] ) );
        }
    }
    return '0.0.0.0';
}

/**
 * REST permission callback.
 * Header-only by design: a URL param fallback would let the key leak into
 * server access logs, browser history, and Referer headers.
 *
 * Rate-limits auth failures to 10 attempts per IP per 5 minutes.
 *
 * @param  WP_REST_Request $req
 * @return true|WP_Error
 */
function claude_auth( $req ) {
    $provided = (string) ( $req->get_header( 'X-Claude-Key' ) ?? '' );

    if ( $provided === '' ) {
        return new WP_Error( 'unauthorized', 'Missing API key. Send X-Claude-Key header.', array( 'status' => 401 ) );
    }

    // Rate-limit by IP: block after 10 consecutive failures in a 5-min window.
    $rl_key = 'claude_fail_' . md5( claude_get_request_ip() );
    $fails  = (int) get_transient( $rl_key );
    if ( $fails >= 10 ) {
        return new WP_Error( 'rate_limited', 'Too many failed attempts. Try again in 5 minutes.', array( 'status' => 429 ) );
    }

    if ( ! hash_equals( claude_get_api_key(), $provided ) ) {
        set_transient( $rl_key, $fails + 1, 5 * MINUTE_IN_SECONDS );
        return new WP_Error( 'unauthorized', 'Invalid API key.', array( 'status' => 401 ) );
    }

    // Success — clear the failure counter.
    delete_transient( $rl_key );

    // Establish a WordPress user for the rest of the request. Without this the
    // request runs as user 0 and kses destroys builder content - see
    // claude_assume_user() for the full explanation.
    $assumed = claude_assume_user();
    if ( is_wp_error( $assumed ) ) {
        return $assumed;
    }

    return true;
}

/**
 * Establish a WordPress user for the request.
 *
 * This is the single most important line in the plugin. Before it existed the
 * request ran as user 0 (all three transports authenticate with an API key and
 * relay through rest_do_request(), so claude_auth() is the only choke point),
 * which meant:
 *
 *   1. kses_init() attaches wp_filter_post_kses to content_save_pre whenever
 *      the current user lacks 'unfiltered_html'. For user 0 that is always
 *      true, so wp_insert_post()/wp_update_post() HTML-escaped Gutenberg and
 *      Divi block delimiters:
 *
 *          <!-- wp:divi/section {...} -->  ->  &lt;!-- wp:divi/section ... --&gt;
 *
 *      The call returned 200 with a normal-looking post object, the page then
 *      rendered the escaped comment as visible text, and the builder could no
 *      longer parse the layout. Silent, total data loss on every builder write.
 *
 *   2. post_author defaulted to 0 on created posts, orphaning them.
 *
 *   3. Every capability check inside core functions behaved as an anonymous
 *      visitor.
 *
 * wp_set_current_user() fires the 'set_current_user' action, which core hooks
 * kses_init() to, so the kses filters are re-evaluated against the new user and
 * dropped for anyone holding unfiltered_html.
 *
 * Which account is used is controlled by the claude_connector_user_id option so
 * the site owner stays in charge of it (and so the access log means something).
 * It falls back to the lowest-numbered administrator.
 *
 * @return int|WP_Error  The assumed user ID, or WP_Error if none is available.
 */
function claude_assume_user() {
    $user_id = (int) get_option( 'claude_connector_user_id', 0 );

    if ( $user_id && ! get_userdata( $user_id ) ) {
        $user_id = 0; // configured user has since been deleted
    }

    if ( ! $user_id ) {
        $admins = get_users( array(
            'role'    => 'administrator',
            'number'  => 1,
            'orderby' => 'ID',
            'order'   => 'ASC',
            'fields'  => 'ID',
        ) );
        $user_id = $admins ? (int) $admins[0] : 0;
    }

    if ( ! $user_id ) {
        return new WP_Error(
            'no_user',
            'No administrator account available for the connector to act as. '
            . 'Set one in Settings > Claude Connector.',
            array( 'status' => 500 )
        );
    }

    wp_set_current_user( $user_id );

    // On multisite, ordinary administrators do NOT hold unfiltered_html - only
    // super admins do - so kses_init() will have re-attached the filters above.
    // Drop them explicitly, otherwise builder content is still corrupted.
    if ( ! current_user_can( 'unfiltered_html' ) ) {
        kses_remove_filters();
    }

    return $user_id;
}

/**
 * True if a string looks like it contains Gutenberg/Divi 5 block markup.
 *
 * @param  mixed $content
 * @return bool
 */
function claude_has_blocks( $content ) {
    return is_string( $content ) && false !== strpos( $content, '<!-- wp:' );
}

/**
 * True if a string looks like Divi 5 block markup specifically.
 *
 * @param  mixed $content
 * @return bool
 */
function claude_has_divi5_blocks( $content ) {
    return is_string( $content ) && false !== strpos( $content, '<!-- wp:divi/' );
}

/**
 * Re-read a post after writing and confirm its block delimiters survived.
 *
 * Guards against the kses regression described in claude_assume_user(). Cheap
 * enough to run on every content write, and it turns what used to be silent
 * corruption into a loud error.
 *
 * @param  int $post_id
 * @return WP_Error|null
 */
function claude_assert_blocks_survived( $post_id ) {
    $written = get_post_field( 'post_content', $post_id );

    if ( is_string( $written ) && false !== strpos( $written, '&lt;!-- wp:' ) ) {
        return new WP_Error(
            'block_corruption_detected',
            'Block delimiters were HTML-escaped during the write, so the builder '
            . 'can no longer parse this layout. The request is running without '
            . 'the unfiltered_html capability. Check the account configured in '
            . 'Settings > Claude Connector.',
            array( 'status' => 500, 'post_id' => $post_id )
        );
    }

    return null;
}

/**
 * Apply the postmeta a Divi 5 page needs to render through the builder.
 *
 * @param  int  $post_id
 * @param  bool $force  Overwrite existing layout choices. Defaults to false so
 *                      an editor's own settings on an existing page survive.
 * @return array        The meta keys that were written.
 */
function claude_divi5_apply_meta( $post_id, $force = false ) {
    $written = array();

    foreach ( CLAUDE_DIVI5_META as $key => $value ) {
        // _et_pb_use_builder is load-bearing, so always assert it. The layout
        // defaults are only filled in when absent.
        $always = ( '_et_pb_use_builder' === $key || '_et_pb_use_divi_5' === $key );

        if ( $force || $always || '' === (string) get_post_meta( $post_id, $key, true ) ) {
            update_post_meta( $post_id, $key, $value );
            $written[] = $key;
        }
    }

    if ( defined( 'ET_BUILDER_PRODUCT_VERSION' ) ) {
        update_post_meta( $post_id, '_et_builder_version', ET_BUILDER_PRODUCT_VERSION );
        $written[] = '_et_builder_version';
    }

    return $written;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Admin settings page
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'admin_menu', function () {
    add_options_page(
        'Claude Connector',
        'Claude Connector',
        'manage_options',
        'claude-connector',
        'claude_settings_page'
    );
} );

function claude_settings_page() {
    if ( ! current_user_can( 'manage_options' ) ) {
        return;
    }
    global $wpdb;
    if (
        isset( $_POST['claude_regen'], $_POST['_wpnonce'] )
        && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_wpnonce'] ) ), 'claude_regen' )
    ) {
        update_option( 'claude_connector_api_key', bin2hex( random_bytes( 32 ) ), false );
        echo '<div class="notice notice-success"><p><strong>API key regenerated.</strong> Update your Claude sessions with the new key.</p></div>';
    }

    if (
        isset( $_POST['claude_save_settings'], $_POST['_wpnonce'] )
        && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_wpnonce'] ) ), 'claude_save_settings' )
    ) {
        update_option( 'claude_connector_logging', isset( $_POST['claude_logging_enabled'] ) ? 1 : 0, false );
        $custom_wp = sanitize_text_field( wp_unslash( $_POST['claude_wpcli_path'] ?? '' ) );
        update_option( 'claude_wpcli_path', $custom_wp, false );
        update_option( 'claude_connector_user_id', (int) ( $_POST['claude_connector_user_id'] ?? 0 ), false );
        update_option( 'claude_trusted_admins', claude_trusted_clean( sanitize_textarea_field( wp_unslash( $_POST['claude_trusted_admins'] ?? '' ) ) ), false );
        echo '<div class="notice notice-success"><p><strong>Settings saved.</strong></p></div>';
    }

    if (
        isset( $_POST['claude_clear_log'], $_POST['_wpnonce'] )
        && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_wpnonce'] ) ), 'claude_clear_log' )
    ) {
        $wpdb->query( "TRUNCATE TABLE {$wpdb->prefix}claude_log" );
        echo '<div class="notice notice-success"><p><strong>Access log cleared.</strong></p></div>';
    }

    $logging_enabled = (bool) get_option( 'claude_connector_logging', 1 );
    $acting_user_id  = (int) get_option( 'claude_connector_user_id', 0 );

    // Resolve the account the connector will actually act as, and surface a
    // capability problem here rather than letting it silently corrupt builder
    // content on the next write. See claude_assume_user().
    $acting_user = $acting_user_id ? get_userdata( $acting_user_id ) : null;
    if ( ! $acting_user ) {
        $fallback    = get_users( array( 'role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC' ) );
        $acting_user = $fallback ? $fallback[0] : null;
    }
    if ( $acting_user && ! user_can( $acting_user, 'unfiltered_html' ) ) {
        echo '<div class="notice notice-error"><p><strong>Warning:</strong> the account the connector acts as ('
            . esc_html( $acting_user->user_login )
            . ') does not have the <code>unfiltered_html</code> capability. Gutenberg and Divi block '
            . 'delimiters will be HTML-escaped when content is written, which destroys builder layouts. '
            . 'Pick an administrator account in the settings below.</p></div>';
    }

    $key        = claude_get_api_key();
    $base_url   = rest_url( CLAUDE_CONNECTOR_NS );

    $last_access = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}claude_log ORDER BY id DESC LIMIT 1", ARRAY_A );

    $endpoints = array(
        array( 'GET',    '/status',                   'Site info, WP/PHP version, active theme & plugins, acting-as user' ),
        array( 'GET',    '/render',                   'Fetch a page server-side and summarise its rendered health' ),
        array( 'GET',    '/blocks/validate/{id}',     'Check block markup for escaped delimiters / bad attribute JSON' ),
        array( 'POST',   '/content/replace',          'Find/replace in content using plain HTML, builder-escaping aware' ),
        array( 'GET',    '/divi/audit',               'Find Divi pages with missing builder meta or mismatched CSS indices' ),
        array( 'POST',   '/divi/resave',              'Re-save builder posts so Divi regenerates its CSS cleanly' ),
        array( 'POST',   '/divi/meta/{id}',           'Repair Divi builder postmeta on an existing page' ),
        array( 'GET',    '/divi/modules?name=',       'Divi 5 module list, or one module (?name=) with its attribute paths, from the schema Divi ships' ),
        array( 'POST',   '/divi/library',             'Save a layout to the Divi Library (safe hand-over, affects nothing until loaded)' ),
        array( 'GET',    '/elementor/kit',            'Elementor global colours and typography - the design tokens of the site' ),
        array( 'POST',   '/files/fetch',              'Download a URL straight into wp-content, server-side' ),
        array( 'GET',    '/acf/groups',               'List ACF/SCF field groups and sync status' ),
        array( 'POST',   '/acf/sync',                 'Sync field groups from local JSON' ),
        array( 'GET',    '/acf/groups/{key}/export',  'Export a field group with all fields as JSON' ),
        array( 'GET',    '/acf/fields/{id}',          'Read all ACF/SCF field values for a post' ),
        array( 'POST',   '/acf/fields/{id}',          'Write ACF/SCF field values for a post' ),
        array( 'GET',    '/acf/options',              'Read all ACF/SCF options-page field values' ),
        array( 'POST',   '/acf/options',              'Write ACF/SCF options-page field values' ),
        array( 'POST',   '/cache/purge',              'Flush all caches (WPEngine, W3TC, Rocket, etc.)' ),
        array( 'GET',    '/posts',                    'Query posts by type, status, search, taxonomy' ),
        array( 'POST',   '/posts',                    'Create a post' ),
        array( 'GET',    '/posts/{id}',               'Get post with all meta & taxonomy terms' ),
        array( 'PUT',    '/posts/{id}',               'Update a post' ),
        array( 'DELETE', '/posts/{id}',               'Delete a post' ),
        array( 'GET',    '/options?key=',             'Read a WordPress option' ),
        array( 'POST',   '/options',                  'Write a WordPress option' ),
        array( 'GET',    '/plugins',                  'List all plugins with active status' ),
        array( 'POST',   '/plugins',                  'Activate, deactivate, install, update or delete a plugin' ),
        array( 'GET',    '/maintenance/overview',     'Core, plugin, theme and translation updates in one call (?refresh=1 re-checks)' ),
        array( 'POST',   '/maintenance/update',       'Update one plugin/theme/core/translations - backed up, health-checked, rolled back on a fatal' ),
        array( 'GET',    '/maintenance/health',       'Load the dashboard and homepage and report any fatal error' ),
        array( 'GET',    '/maintenance/forms',        'Pages with a contact form (Divi, CF7, Gravity, WPForms, Elementor...)' ),
        array( 'POST',   '/maintenance/test-email',   'Send a wp_mail() test and report the mailer in use' ),
        array( 'GET',    '/security/scan',            'Read-only security check: core/plugin checksums, PHP in uploads, malware patterns, new admins, redirects' ),
        array( 'GET',    '/security/core-file?path=', 'Read a file or list a folder outside wp-content (path empty = site root): core files with their diff against the official copy, planted files with malware hits - read-only, never wp-config.php' ),
        array( 'POST',   '/security/reinstall-core',  'Restore all core files to the official same-version copy (fixes modified/missing core; wp-content untouched)' ),
        array( 'GET',    '/security/htaccess',        'The site-root .htaccess as segments, with injected-looking lines flagged (POST { remove?: [ids] } restores WordPress\'s rules, keeps a copy, reverts if the site breaks)' ),
        array( 'GET',    '/security/trusted-hosts',   'Widget / embed domains the security check trusts besides its built-in list (POST { hosts: [...] } to set)' ),
        array( 'GET',    '/security/trusted-admins',  'Administrator emails the security check trusts (POST { emails: [...] } to set; "@domain.com" for a domain)' ),
        array( 'POST',   '/security/quarantine',      'Move added (non-core) files out of the live site into quarantine - { path } or { paths: [...] }, incl. outside wp-content; reversible' ),
        array( 'GET',    '/security/quarantine',      'List quarantined files' ),
        array( 'POST',   '/security/restore',         'Put a quarantined file back' ),
        array( 'GET',    '/divi/forms',               'Divi contact forms and their email Message Pattern: missing fields, placeholders matching no field' ),
        array( 'POST',   '/divi/forms/pattern',       'Set a Divi contact form\'s Message Pattern (previous one kept for undo)' ),
        array( 'GET',    '/themes',                   'List installed themes' ),
        array( 'POST',   '/themes',                   'Switch active theme { stylesheet }, or delete an unused theme { action: "delete", stylesheet }' ),
        array( 'GET',    '/files?path=',              'List files in a wp-content subdirectory' ),
        array( 'GET',    '/files/read',               'Read a file\'s content' ),
        array( 'POST',   '/files',                    'Write (create or overwrite) a file — PHP lint + auto-backup' ),
        array( 'DELETE', '/files?path=',              'Delete a file or empty directory' ),
        array( 'POST',   '/files/stage',              'Stage a base64 chunk for WAF-bypass write (use with /files/commit)' ),
        array( 'POST',   '/files/commit',             'Commit staged chunks and write file to disk — PHP lint + auto-backup' ),
        array( 'GET',    '/db/tables',                'List database tables' ),
        array( 'POST',   '/db/query',                 'Execute a SQL query (pass readonly:true to block writes)' ),
        array( 'GET',    '/logs',                     'View recent API access log' ),
        array( 'POST',   '/logs/clear',               'Clear the access log' ),
        array( 'POST',   '/wpcli',                    'Run a WP-CLI command - accepts args[] array or command string' ),
        array( 'POST',   '/wp-admin/admin-ajax.php?action=claude_cmd', 'Admin-AJAX mode — bypasses /wp-json/ WAF rules' ),
        array( 'POST',   '/wp-admin/admin-ajax.php?action=claude_enc', 'Encrypted mode — AES-256-GCM payload, bypasses body-inspection WAF (Imunify360)' ),
    );
    $colours = array( 'GET' => '#0074a2', 'POST' => '#007a3d', 'PUT' => '#856404', 'DELETE' => '#a00' );
    ?>
    <div class="wrap">
        <h1>Claude Connector <span style="font-size:13px;font-weight:400;color:#666;">v<?php echo esc_html( CLAUDE_CONNECTOR_VERSION ); ?></span></h1>
        <?php if ( isset( $_GET['welcome'] ) ) : // phpcs:ignore ?>
        <div class="notice notice-success"><p><strong>Claude Connector is active.</strong> Press <strong>Connect on this Mac</strong> (or <strong>Connect on this PC</strong>) below to add this site to the Site Maintenance dashboard.</p></div>
        <?php endif; ?>
        <table class="form-table" role="presentation">
            <tr>
                <th>API Key</th>
                <td>
                    <input type="password" id="claude-api-key" value="<?php echo esc_attr( $key ); ?>"
                           style="width:440px;font-family:monospace;font-size:12px;"
                           readonly onclick="this.select()">
                    <button type="button" class="button button-secondary" onclick="var f=document.getElementById('claude-api-key');f.type=(f.type==='password'?'text':'password');this.textContent=(f.type==='password'?'Show':'Hide');">Show</button>
                    <p class="description">
                        Send as <code>X-Claude-Key: &lt;key&gt;</code> on every request.<br>
                        To pin permanently, add to <code>wp-config.php</code>:<br>
                        <code>define( 'CLAUDE_API_KEY', '<?php echo esc_attr( $key ); ?>' );</code>
                    </p>
                </td>
            </tr>
            <tr><th>Base URL</th><td><code><?php echo esc_url( $base_url ); ?></code></td></tr>
            <tr>
                <th>Health Check</th>
                <td>
                    <button type="button" id="claude-test-btn" class="button button-secondary">Test connection</button>
                    <span id="claude-test-result" style="margin-left:8px;"></span>
                </td>
            </tr>
            <tr>
                <th>Last Access</th>
                <td>
                <?php if ( $last_access ) : ?>
                    <strong><?php echo esc_html( get_date_from_gmt( $last_access['time'], 'D, d M Y H:i:s' ) ); ?></strong>
                    &nbsp;-&nbsp;
                    IP: <code><?php echo esc_html( $last_access['ip'] ); ?></code>
                    &nbsp;-&nbsp;
                    <span style="font-family:monospace;"><?php echo esc_html( $last_access['method'] . ' ' . $last_access['endpoint'] ); ?></span>
                    &nbsp;
                    <span style="color:<?php echo (int) $last_access['status'] >= 400 ? '#a00' : '#007a3d'; ?>;font-weight:700;"><?php echo esc_html( $last_access['status'] ); ?></span>
                <?php else : ?>
                    <em style="color:#666;">No requests recorded yet.</em>
                <?php endif; ?>
                </td>
            </tr>
        </table>
        <script>
        (function () {
            var btn = document.getElementById( 'claude-test-btn' );
            var out = document.getElementById( 'claude-test-result' );
            btn.addEventListener( 'click', function () {
                btn.disabled = true;
                out.style.color = '#666';
                out.textContent = 'Testing...';
                fetch( <?php echo wp_json_encode( esc_url_raw( $base_url . '/status' ) ); ?>, {
                    headers: { 'X-Claude-Key': document.getElementById( 'claude-api-key' ).value }
                } ).then( function ( r ) {
                    return r.json().then( function ( data ) { return { ok: r.ok, status: r.status, data: data }; } );
                } ).then( function ( res ) {
                    btn.disabled = false;
                    if ( res.ok ) {
                        out.style.color = '#007a3d';
                        out.textContent = 'Connected - WP ' + ( res.data.wp_version || '' );
                    } else {
                        out.style.color = '#a00';
                        out.textContent = 'Failed: ' + ( res.data.message || ( 'HTTP ' + res.status ) );
                    }
                } ).catch( function ( e ) {
                    btn.disabled = false;
                    out.style.color = '#a00';
                    out.textContent = 'Failed: ' + e.message;
                } );
            } );
        })();
        </script>
        <h2>Settings</h2>
        <form method="post">
            <?php wp_nonce_field( 'claude_save_settings' ); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th>Act as user</th>
                    <td>
                        <?php
                        wp_dropdown_users( array(
                            'name'             => 'claude_connector_user_id',
                            'selected'         => $acting_user_id,
                            'show_option_none' => '- lowest-numbered administrator -',
                            'option_none_value'=> 0,
                            'role'             => 'administrator',
                        ) );
                        ?>
                        <p class="description">
                            The account API requests run as. It must be an administrator, because
                            WordPress escapes Gutenberg and Divi block delimiters for any user without
                            the <code>unfiltered_html</code> capability - which silently destroys
                            builder layouts on write. This also sets the author of posts the connector
                            creates, and is what appears in the access log.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th>Trusted administrator emails</th>
                    <td>
                        <textarea name="claude_trusted_admins" rows="4" style="width:420px;font-family:monospace;" placeholder="you@youragency.com&#10;owner@client.com&#10;@youragency.com"><?php echo esc_textarea( implode( "\n", claude_trusted_admins() ) ); ?></textarea>
                        <p class="description">
                            One per line. The security check trusts administrators with these emails whatever their
                            username, and flags every other administrator. <code>@domain.com</code> trusts a whole domain,
                            but still flags accounts created in the last 30 days - anyone with admin access can create an
                            address at your domain. The Site Maintenance dashboard keeps this list in sync.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th>WP-CLI Path</th>
                    <td>
                        <?php $detected = claude_find_wpcli(); ?>
                        <input type="text" name="claude_wpcli_path"
                               value="<?php echo esc_attr( get_option( 'claude_wpcli_path', '' ) ); ?>"
                               style="width:420px;font-family:monospace;"
                               placeholder="/usr/local/bin/wp">
                        <p class="description">
                            Leave blank to auto-detect.
                            <?php if ( $detected ) : ?>
                            <strong style="color:#007a3d;">Found: <code><?php echo esc_html( $detected ); ?></code></strong>
                            <?php else : ?>
                            <strong style="color:#a00;">Not found</strong> - install WP-CLI or paste the full path above.
                            <?php endif; ?>
                        </p>
                    </td>
                </tr>
                <tr>
                    <th>Access Logging</th>
                    <td>
                        <label>
                            <input type="checkbox" name="claude_logging_enabled" value="1"
                                <?php checked( $logging_enabled ); ?>>
                            Enable access log
                        </label>
                        <p class="description">Records IP, method, endpoint, status, and time for every API request. The last access is always shown above regardless of this setting.</p>
                    </td>
                </tr>
            </table>
            <button type="submit" name="claude_save_settings" value="1" class="button button-primary">Save Settings</button>
        </form>

        <h2 style="margin-top:1.5em;">Regenerate API Key</h2>
        <form method="post">
            <?php wp_nonce_field( 'claude_regen' ); ?>
            <p>Generating a new key will immediately invalidate the current one.</p>
            <button type="submit" name="claude_regen" value="1" class="button button-secondary"
                    onclick="return confirm('Regenerate key? Current key stops working immediately.')">Regenerate Key</button>
        </form>
        <h2 style="margin-top:1.5em;">Connect Claude Code</h2>
        <p class="description">Sets up this site on your computer: installs the MCP bridge, creates a workspace folder for the site, and opens it in VSCode - Claude Code connects automatically. Requires Node.js (<a href="https://nodejs.org" target="_blank">nodejs.org</a>) and VSCode with the Claude Code extension.</p>
        <div id="claude-setup-mac" style="margin-top:12px;max-width:960px;">
            <p style="margin:0 0 8px;"><strong>Mac</strong> - pick any option:</p>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div style="flex:1 1 280px;border:1px solid #c3c4c7;border-radius:6px;padding:12px 14px;background:#fff;">
                    <h3 style="margin:0 0 4px;font-size:14px;">Option 1 - Connect on this Mac</h3>
                    <p class="description" style="margin:0 0 10px;">One click, if the Site Maintenance app is installed on this Mac. It sets up the workspace, opens VS Code and adds the site to the dashboard.</p>
                    <button type="button" class="button button-primary" id="claude-connect-mac">Connect on this Mac</button>
                    <p class="description" id="claude-connect-hint" style="display:none;margin-top:8px;">Your browser asks to open <em>Site Maintenance</em> - allow it. Nothing happened? The app is not installed: in the repo's <code>dashboard</code> folder run <code>npm run shortcut</code>, or use option 2.</p>
                </div>
                <div style="flex:1 1 280px;border:1px solid #c3c4c7;border-radius:6px;padding:12px 14px;background:#fff;">
                    <h3 style="margin:0 0 4px;font-size:14px;">Option 2 - Copy &amp; paste in Terminal</h3>
                    <p class="description" style="margin:0 0 10px;">Fastest: no Gatekeeper prompt, nothing to approve.</p>
                    <button type="button" class="button button-primary" id="claude-setup-get">Show setup command</button>
                    <div id="claude-setup-out" style="display:none;margin-top:10px;">
                        <ol style="margin:0 0 8px 18px;">
                            <li>Copy the command.</li>
                            <li>Open <em>Terminal</em> (&#8984; Space &rarr; type "Terminal").</li>
                            <li>Paste it and press Return.</li>
                        </ol>
                        <div style="display:flex;gap:8px;align-items:flex-start;">
                            <code id="claude-setup-cmd" style="flex:1;display:block;padding:8px 10px;word-break:break-all;user-select:all;"></code>
                            <button type="button" class="button" id="claude-setup-copy">Copy</button>
                        </div>
                        <p class="description" style="margin-top:6px;">Works once and expires in 15 minutes - it carries this site's API key.</p>
                    </div>
                </div>
                <div style="flex:1 1 280px;border:1px solid #c3c4c7;border-radius:6px;padding:12px 14px;background:#fff;">
                    <h3 style="margin:0 0 4px;font-size:14px;">Option 3 - Download the installer</h3>
                    <p class="description" style="margin:0 0 10px;">macOS asks you to approve it once, because it was downloaded.</p>
                    <a id="claude-dl-mac" class="button button-primary" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-ajax.php?action=claude_connect_script&os=mac' ), 'claude_connect_script' ) ); ?>">&#8984;&nbsp; Download Mac installer</a>
                    <ol style="margin:10px 0 0 18px;">
                        <li>Open the downloaded <code>.zip</code> (Safari unzips it for you).</li>
                        <li>Double-click <code>connect-&hellip;.command</code>. macOS says it cannot be opened - click <em>Done</em>.</li>
                        <li>Open <em>System Settings &rarr; Privacy &amp; Security</em>, scroll down to the message about <code>connect-&hellip;.command</code> and click <strong>Open Anyway</strong>, then confirm with your password.</li>
                        <li>Click <strong>Open</strong> when asked again. A Terminal window runs the setup.</li>
                    </ol>
                </div>
            </div>
        </div>
        <div id="claude-setup-windows" style="margin-top:12px;max-width:960px;">
            <p style="margin:0 0 8px;"><strong>Windows</strong> - pick either option:</p>
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div style="flex:1 1 280px;border:1px solid #c3c4c7;border-radius:6px;padding:12px 14px;background:#fff;">
                    <h3 style="margin:0 0 4px;font-size:14px;">Option 1 - Connect on this PC</h3>
                    <p class="description" style="margin:0 0 10px;">One click, if the Site Maintenance dashboard is running on this PC. It sets up the workspace, opens VS Code and adds the site to the dashboard.</p>
                    <button type="button" class="button button-primary" id="claude-connect-win">Connect on this PC</button>
                    <p class="description" id="claude-connect-win-hint" style="display:none;margin-top:8px;">Confirm in the dashboard tab that opened. It says the page cannot be reached? The dashboard is not running: in the repo's <code>dashboard</code> folder run <code>npm start</code>, then click again - or use option 2.</p>
                </div>
                <div style="flex:1 1 280px;border:1px solid #c3c4c7;border-radius:6px;padding:12px 14px;background:#fff;">
                    <h3 style="margin:0 0 4px;font-size:14px;">Option 2 - Download the script</h3>
                    <p class="description" style="margin:0 0 10px;">Download it, then right-click it &rarr; Run with PowerShell.</p>
                    <a id="claude-dl-windows" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-ajax.php?action=claude_connect_script&os=windows' ), 'claude_connect_script' ) ); ?>"
                       class="button button-primary">&#x229e;&nbsp; Download Windows Script (.ps1)</a>
                </div>
            </div>
        </div>
        <script>
        (function () {
            // Progressive enhancement: both render by default (works with JS off);
            // hide whichever one doesn't match the visitor's OS.
            var ua    = navigator.userAgent || '';
            var isWin = /Windows/i.test( ua );
            var isMac = /Macintosh|Mac OS X/i.test( ua ) && ! isWin;
            if ( isWin ) document.getElementById( 'claude-setup-mac' ).style.display = 'none';
            else if ( isMac ) document.getElementById( 'claude-setup-windows' ).style.display = 'none';

            var btn = document.getElementById( 'claude-setup-get' );
            var out = document.getElementById( 'claude-setup-out' );
            var cmd = document.getElementById( 'claude-setup-cmd' );
            // Each call hands out fresh single-use tokens.
            function fetchSetup() {
                var body = new FormData();
                body.append( 'action', 'claude_setup_command' );
                body.append( '_ajax_nonce', <?php echo wp_json_encode( wp_create_nonce( 'claude_setup_command' ) ); ?> );
                return fetch( <?php echo wp_json_encode( admin_url( 'admin-ajax.php' ) ); ?>, { method: 'POST', body: body, credentials: 'same-origin' } )
                    .then( function ( r ) { return r.json(); } )
                    .then( function ( r ) {
                        if ( ! r.success ) throw new Error( r.data || 'Request failed' );
                        return r.data;
                    } );
            }
            btn.addEventListener( 'click', function () {
                btn.disabled = true;
                fetchSetup()
                    .then( function ( d ) {
                        cmd.textContent = d.command;
                        out.style.display = '';
                        btn.textContent = 'New setup command';
                    } )
                    .catch( function ( e ) { alert( 'Could not create the setup command: ' + e.message ); } )
                    .then( function () { btn.disabled = false; } );
            } );
            var cbtn = document.getElementById( 'claude-connect-mac' );
            cbtn.addEventListener( 'click', function () {
                cbtn.disabled = true;
                fetchSetup()
                    .then( function ( d ) {
                        window.location.href = d.connect;
                        document.getElementById( 'claude-connect-hint' ).style.display = '';
                    } )
                    .catch( function ( e ) { alert( 'Could not create the connect link: ' + e.message ); } )
                    .then( function () { cbtn.disabled = false; } );
            } );
            // Windows has no Site Maintenance app: open the dashboard's connect screen directly.
            var wbtn = document.getElementById( 'claude-connect-win' );
            wbtn.addEventListener( 'click', function () {
                // Open the tab during the click so popup blockers allow it, then point it at the dashboard.
                var tab = window.open( 'about:blank', '_blank' );
                if ( tab ) tab.opener = null;
                wbtn.disabled = true;
                fetchSetup()
                    .then( function ( d ) {
                        var url = 'http://127.0.0.1:4590/#connect=' + encodeURIComponent( d.connect );
                        if ( tab ) tab.location.href = url;
                        else window.open( url, '_blank', 'noopener' );
                        document.getElementById( 'claude-connect-win-hint' ).style.display = '';
                    } )
                    .catch( function ( e ) {
                        if ( tab ) tab.close();
                        alert( 'Could not create the connect link: ' + e.message );
                    } )
                    .then( function () { wbtn.disabled = false; } );
            } );
            document.getElementById( 'claude-setup-copy' ).addEventListener( 'click', function () {
                var b = this;
                navigator.clipboard.writeText( cmd.textContent ).then( function () {
                    b.textContent = 'Copied';
                    setTimeout( function () { b.textContent = 'Copy'; }, 1500 );
                } );
            } );
        })();
        </script>
        <h2 style="margin-top:2em;">Available Endpoints</h2>
        <table class="widefat" style="max-width:760px;">
            <thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead>
            <tbody>
                <?php foreach ( $endpoints as $e ) : ?>
                <tr>
                    <td><span style="color:<?php echo esc_attr( $colours[ $e[0] ] ?? '#666' ); ?>;font-weight:700;font-family:monospace;"><?php echo esc_html( $e[0] ); ?></span></td>
                    <td><code><?php echo esc_html( CLAUDE_CONNECTOR_NS . $e[1] ); ?></code></td>
                    <td><?php echo esc_html( $e[2] ); ?></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>

        <h2 style="margin-top:2em;">Recent API Access Log</h2>
        <?php if ( ! $logging_enabled ) : ?>
        <p class="description">Logging is disabled. Enable it in Settings above to record all requests.</p>
        <?php else :
        $log_rows = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}claude_log ORDER BY id DESC LIMIT 50", ARRAY_A );
        if ( $log_rows ) :
        ?>
        <table class="widefat" style="max-width:900px;">
            <thead><tr><th>Time (local)</th><th>IP</th><th>Method</th><th>Endpoint</th><th>Status</th></tr></thead>
            <tbody>
            <?php foreach ( $log_rows as $row ) : ?>
                <tr>
                    <td style="white-space:nowrap;"><?php echo esc_html( get_date_from_gmt( $row['time'], 'Y-m-d H:i:s' ) ); ?></td>
                    <td><code><?php echo esc_html( $row['ip'] ); ?></code></td>
                    <td><span style="color:<?php echo esc_attr( $colours[ $row['method'] ] ?? '#666' ); ?>;font-weight:700;font-family:monospace;"><?php echo esc_html( $row['method'] ); ?></span></td>
                    <td><code><?php echo esc_html( $row['endpoint'] ); ?></code></td>
                    <td style="color:<?php echo (int) $row['status'] >= 400 ? '#a00' : '#007a3d'; ?>;font-weight:700;"><?php echo esc_html( $row['status'] ); ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
        <form method="post" style="margin-top:8px;">
            <?php wp_nonce_field( 'claude_clear_log' ); ?>
            <button type="submit" name="claude_clear_log" value="1" class="button button-secondary"
                    onclick="return confirm('Clear all log entries?')">Clear Log</button>
        </form>
        <?php else : ?>
        <p class="description">No requests logged yet.</p>
        <?php endif; endif; ?>
    </div>
    <?php
}

// ──────────────────────────────────────────────────────────────────────────────
//  Register REST routes
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'rest_api_init', function () {
    $a  = 'claude_auth';
    $ns = CLAUDE_CONNECTOR_NS;

    register_rest_route( $ns, '/status',                          array( 'methods' => 'GET',  'callback' => 'claude_status',           'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/groups',                     array( 'methods' => 'GET',  'callback' => 'claude_acf_groups',       'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/sync',                       array( 'methods' => 'POST', 'callback' => 'claude_acf_sync',         'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/groups/(?P<key>[a-z0-9_]+)/export', array( 'methods' => 'GET',  'callback' => 'claude_acf_group_export', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/fields/(?P<id>\d+)',         array(
        array( 'methods' => 'GET',  'callback' => 'claude_acf_fields_get', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_acf_fields_set', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/acf/options',                    array(
        array( 'methods' => 'GET',  'callback' => 'claude_acf_options_get', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_acf_options_set', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/elementor/widgets',              array( 'methods' => 'GET',  'callback' => 'claude_elementor_widgets', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/elementor/kit',                  array( 'methods' => 'GET',  'callback' => 'claude_elementor_kit',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/elementor/data/(?P<id>\d+)',     array(
        array( 'methods' => 'GET',  'callback' => 'claude_elementor_data_get', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_elementor_data_set', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/divi/modules',                   array( 'methods' => 'GET',  'callback' => 'claude_divi_modules',  'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/library',                   array( 'methods' => 'POST', 'callback' => 'claude_divi_library_save', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/data/(?P<id>\d+)',          array(
        array( 'methods' => 'GET',  'callback' => 'claude_divi_data_get', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_divi_data_set', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/divi/audit',                     array( 'methods' => 'GET',  'callback' => 'claude_divi_audit',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/resave',                    array( 'methods' => 'POST', 'callback' => 'claude_divi_resave',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/meta/(?P<id>\d+)',          array( 'methods' => 'POST', 'callback' => 'claude_divi_meta_set', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/render',                         array( 'methods' => 'GET',  'callback' => 'claude_page_render',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/blocks/validate/(?P<id>\d+)',    array( 'methods' => 'GET',  'callback' => 'claude_blocks_validate', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/content/replace',                array( 'methods' => 'POST', 'callback' => 'claude_content_replace', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/cache/purge',                    array( 'methods' => 'POST', 'callback' => 'claude_cache_purge',      'permission_callback' => $a ) );
    register_rest_route( $ns, '/posts',              array(
        array( 'methods' => 'GET',  'callback' => 'claude_posts_list',   'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_posts_create', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/posts/(?P<id>\d+)', array(
        array( 'methods' => 'GET',    'callback' => 'claude_posts_get',    'permission_callback' => $a ),
        array( 'methods' => 'PUT',    'callback' => 'claude_posts_update', 'permission_callback' => $a ),
        array( 'methods' => 'DELETE', 'callback' => 'claude_posts_delete', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/options', array(
        array( 'methods' => 'GET',  'callback' => 'claude_options_get', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_options_set', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/plugins', array(
        array( 'methods' => 'GET',  'callback' => 'claude_plugins_list',   'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_plugins_manage', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/themes', array(
        array( 'methods' => 'GET',  'callback' => 'claude_themes_list',   'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_themes_switch', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/files', array(
        array( 'methods' => 'GET',    'callback' => 'claude_files_list',   'permission_callback' => $a ),
        array( 'methods' => 'POST',   'callback' => 'claude_files_write',  'permission_callback' => $a ),
        array( 'methods' => 'DELETE', 'callback' => 'claude_files_delete', 'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/files/read',   array( 'methods' => 'GET',  'callback' => 'claude_files_read',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/files/fetch',  array( 'methods' => 'POST', 'callback' => 'claude_files_fetch',  'permission_callback' => $a ) );
    register_rest_route( $ns, '/files/stage',  array( 'methods' => 'POST', 'callback' => 'claude_files_stage',  'permission_callback' => $a ) );
    register_rest_route( $ns, '/files/commit', array( 'methods' => 'POST', 'callback' => 'claude_files_commit', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/db/tables',    array( 'methods' => 'GET',  'callback' => 'claude_db_tables',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/db/query',     array( 'methods' => 'POST', 'callback' => 'claude_db_query',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/logs',         array( 'methods' => 'GET',  'callback' => 'claude_logs_list',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/logs/clear',   array( 'methods' => 'POST', 'callback' => 'claude_logs_clear',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/wpcli',        array( 'methods' => 'POST', 'callback' => 'claude_wpcli',        'permission_callback' => $a ) );
    register_rest_route( $ns, '/maintenance/overview',   array( 'methods' => 'GET',  'callback' => 'claude_maint_overview',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/maintenance/update',     array( 'methods' => 'POST', 'callback' => 'claude_maint_update',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/maintenance/health',     array( 'methods' => 'GET',  'callback' => 'claude_maint_health',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/maintenance/forms',      array( 'methods' => 'GET',  'callback' => 'claude_maint_forms',      'permission_callback' => $a ) );
    register_rest_route( $ns, '/maintenance/test-email', array( 'methods' => 'POST', 'callback' => 'claude_maint_test_email', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/scan',          array( 'methods' => 'GET',  'callback' => 'claude_security_scan',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/core-file',     array( 'methods' => 'GET',  'callback' => 'claude_security_core_file', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/reinstall-core', array( 'methods' => 'POST', 'callback' => 'claude_security_reinstall_core', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/htaccess', array( 'methods' => array( 'GET', 'POST' ), 'callback' => 'claude_security_htaccess', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/trusted-hosts', array( 'methods' => array( 'GET', 'POST' ), 'callback' => 'claude_security_trusted_hosts', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/trusted-admins', array( 'methods' => array( 'GET', 'POST' ), 'callback' => 'claude_security_trusted_admins', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/security/quarantine',    array(
        array( 'methods' => 'GET',  'callback' => 'claude_security_quarantine_list', 'permission_callback' => $a ),
        array( 'methods' => 'POST', 'callback' => 'claude_security_quarantine',      'permission_callback' => $a ),
    ) );
    register_rest_route( $ns, '/security/restore',       array( 'methods' => 'POST', 'callback' => 'claude_security_restore', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/forms',             array( 'methods' => 'GET',  'callback' => 'claude_divi_forms',       'permission_callback' => $a ) );
    register_rest_route( $ns, '/divi/forms/pattern',     array( 'methods' => 'POST', 'callback' => 'claude_divi_set_pattern', 'permission_callback' => $a ) );
} );

// Log every request to our namespace after dispatch (only when logging is enabled).
add_filter( 'rest_post_dispatch', function ( $response, $server, $request ) {
    if (
        get_option( 'claude_connector_logging', 1 )
        && strpos( $request->get_route(), '/' . CLAUDE_CONNECTOR_NS ) === 0
    ) {
        claude_log_access( $request, $response );
    }
    return $response;
}, 10, 3 );

// ──────────────────────────────────────────────────────────────────────────────
//  Status
// ──────────────────────────────────────────────────────────────────────────────

function claude_status() {
    $theme = wp_get_theme();
    return new WP_REST_Response( array(
        'status'         => 'ok',
        'plugin_version' => CLAUDE_CONNECTOR_VERSION,
        'wp_version'     => get_bloginfo( 'version' ),
        'php_version'    => PHP_VERSION,
        'site_url'       => get_site_url(),
        'home_url'       => get_home_url(),
        'active_theme'   => array(
            'name'       => $theme->get( 'Name' ),
            'stylesheet' => get_stylesheet(),
            'template'   => get_template(),
            'version'    => $theme->get( 'Version' ),
        ),
        'active_plugins' => get_option( 'active_plugins', array() ),
        'uploads_url'    => wp_upload_dir()['baseurl'],
        'charset'        => get_bloginfo( 'charset' ),
        'is_multisite'   => is_multisite(),
        'timezone'       => wp_timezone_string(),
        'endpoints'      => rest_url( CLAUDE_CONNECTOR_NS ),

        // Identity of the account the connector acts as. If this is 0 or lacks
        // unfiltered_html, builder content will be corrupted on write - see
        // claude_assume_user().
        'acting_as'      => array(
            'user_id'         => get_current_user_id(),
            'login'           => wp_get_current_user()->user_login ?: null,
            'unfiltered_html' => current_user_can( 'unfiltered_html' ),
        ),

        // Lets the MCP server detect version skew between itself and the plugin.
        'builder'        => array(
            'divi_active'     => claude_divi_active(),
            'divi_generation' => claude_divi_active() ? claude_divi_generation() : null,
            'divi_version'    => defined( 'ET_BUILDER_PRODUCT_VERSION' ) ? ET_BUILDER_PRODUCT_VERSION : null,
            'elementor'       => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
        ),
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  ACF
// ──────────────────────────────────────────────────────────────────────────────

function claude_acf_groups() {
    if ( ! function_exists( 'acf_get_field_groups' ) ) {
        return new WP_Error( 'acf_missing', 'ACF is not active on this site.', array( 'status' => 422 ) );
    }
    $result = array();
    foreach ( acf_get_field_groups() as $g ) {
        $result[] = array(
            'key'      => $g['key'],
            'title'    => $g['title'],
            'active'   => (bool) $g['active'],
            'fields'   => count( acf_get_fields( $g['key'] ) ?: array() ),
            'location' => $g['location'],
        );
    }
    return new WP_REST_Response( $result );
}

function claude_acf_sync( $req ) {
    if ( ! function_exists( 'acf_get_field_groups' ) ) {
        return new WP_Error( 'acf_missing', 'ACF is not active on this site.', array( 'status' => 422 ) );
    }
    if ( ! function_exists( 'acf_get_local_json_files' ) ) {
        return new WP_Error( 'acf_json', 'ACF local JSON is not available.', array( 'status' => 422 ) );
    }
    $filter_keys = $req->get_param( 'groups' );
    $local_files = acf_get_local_json_files();

    if ( empty( $local_files ) ) {
        return new WP_REST_Response( array( 'synced' => array(), 'message' => 'No local JSON files found.' ) );
    }

    $synced  = array();
    $skipped = array();
    foreach ( $local_files as $group_key => $file_path ) {
        if ( $filter_keys && ! in_array( $group_key, (array) $filter_keys, true ) ) {
            $skipped[] = $group_key;
            continue;
        }
        $json = file_get_contents( $file_path ); // phpcs:ignore
        if ( ! $json ) continue;
        $data = json_decode( $json, true );
        if ( ! is_array( $data ) || empty( $data['key'] ) ) continue;

        $existing = acf_get_field_group( $data['key'] );
        if ( $existing ) {
            $data['ID'] = $existing['ID'];
            acf_update_field_group( $data );
        } else {
            acf_import_field_group( $data );
        }
        $synced[] = array( 'key' => $group_key, 'file' => basename( $file_path ) );
    }
    return new WP_REST_Response( array( 'synced' => $synced, 'skipped' => $skipped, 'count' => count( $synced ) ) );
}

/**
 * GET /acf/groups/{key}/export
 * Returns a field group + all its fields as JSON (same structure as ACF local JSON files).
 * Useful for exporting to version control or inspecting the schema.
 */
function claude_acf_group_export( $req ) {
    if ( ! function_exists( 'acf_get_field_group' ) ) {
        return new WP_Error( 'acf_missing', 'ACF/SCF is not active on this site.', array( 'status' => 422 ) );
    }
    $key   = sanitize_text_field( $req['key'] );
    $group = acf_get_field_group( $key );
    if ( ! $group ) {
        return new WP_Error( 'not_found', "Field group '{$key}' not found.", array( 'status' => 404 ) );
    }
    $group['fields'] = acf_get_fields( $key ) ?: array();
    return new WP_REST_Response( $group );
}

/**
 * GET /acf/fields/{id}
 * Returns all ACF/SCF field values for a post.
 * Supports any post type; pass format_value=false to get raw values (optional param).
 */
function claude_acf_fields_get( $req ) {
    if ( ! function_exists( 'get_fields' ) ) {
        return new WP_Error( 'acf_missing', 'ACF/SCF is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    $format = $req->get_param( 'format_value' ) !== 'false';
    $fields = get_fields( $post_id, $format );
    return new WP_REST_Response( array( 'post_id' => $post_id, 'fields' => $fields ?: array() ) );
}

/**
 * POST /acf/fields/{id}
 * Writes ACF/SCF field values for a post.
 * Body: { "fields": { "field_key_or_name": value, ... } }
 */
function claude_acf_fields_set( $req ) {
    if ( ! function_exists( 'update_field' ) ) {
        return new WP_Error( 'acf_missing', 'ACF/SCF is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    $body   = (array) $req->get_json_params();
    $fields = $body['fields'] ?? null;
    if ( ! is_array( $fields ) || empty( $fields ) ) {
        return new WP_Error( 'missing', 'Body must include "fields" as a non-empty object.', array( 'status' => 400 ) );
    }
    $updated = array();
    $failed  = array();
    foreach ( $fields as $key => $value ) {
        // update_field() returns false only on a genuine failure (field not found or type mismatch).
        // ACF stores through update_metadata(), which wp_unslash()es - slash first or
        // backslashes in values (paths, regex, escaped JSON) are silently stripped.
        $result = update_field( sanitize_text_field( $key ), wp_slash( $value ), $post_id );
        if ( $result !== false ) {
            $updated[] = $key;
        } else {
            $failed[] = $key;
        }
    }
    return new WP_REST_Response( array(
        'post_id' => $post_id,
        'updated' => $updated,
        'failed'  => $failed,
    ) );
}

/**
 * GET /acf/options
 * Returns all ACF/SCF Options Page field values.
 * Requires ACF Pro or a registered options page (acf_add_options_page).
 */
function claude_acf_options_get() {
    if ( ! function_exists( 'get_fields' ) ) {
        return new WP_Error( 'acf_missing', 'ACF/SCF is not active on this site.', array( 'status' => 422 ) );
    }
    $fields = get_fields( 'option' );
    return new WP_REST_Response( array( 'fields' => $fields ?: array() ) );
}

/**
 * POST /acf/options
 * Writes ACF/SCF Options Page field values.
 * Body: { "fields": { "field_key_or_name": value, ... } }
 */
function claude_acf_options_set( $req ) {
    if ( ! function_exists( 'update_field' ) ) {
        return new WP_Error( 'acf_missing', 'ACF/SCF is not active on this site.', array( 'status' => 422 ) );
    }
    $body   = (array) $req->get_json_params();
    $fields = $body['fields'] ?? null;
    if ( ! is_array( $fields ) || empty( $fields ) ) {
        return new WP_Error( 'missing', 'Body must include "fields" as a non-empty object.', array( 'status' => 400 ) );
    }
    $updated = array();
    foreach ( $fields as $key => $value ) {
        // ACF wp_unslash()es option values too (acf_update_metadata) - see claude_acf_fields_set().
        update_field( sanitize_text_field( $key ), wp_slash( $value ), 'option' );
        $updated[] = $key;
    }
    return new WP_REST_Response( array( 'updated' => $updated ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Elementor
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GET /elementor/widgets
 * Lists registered Elementor widget types with their editable settings schema, so
 * Claude can build/edit `_elementor_data` trees using this site's real widget and
 * control names (stock + Pro + third-party addons) instead of guessing.
 */
function claude_elementor_widgets() {
    if ( ! class_exists( '\Elementor\Plugin' ) ) {
        return new WP_Error( 'elementor_missing', 'Elementor is not active on this site.', array( 'status' => 422 ) );
    }
    $widgets = array();
    foreach ( \Elementor\Plugin::$instance->widgets_manager->get_widget_types() as $name => $widget ) {
        $controls = array();
        if ( method_exists( $widget, 'get_controls' ) ) {
            foreach ( $widget->get_controls() as $control_name => $control ) {
                if ( ( $control['type'] ?? '' ) === 'section' ) {
                    continue; // UI grouping marker, not an editable field.
                }
                $controls[] = array(
                    'name'    => $control_name,
                    'label'   => $control['label'] ?? '',
                    'type'    => $control['type'] ?? '',
                    'default' => $control['default'] ?? null,
                );
            }
        }
        $widgets[] = array(
            'name'       => $name,
            'title'      => method_exists( $widget, 'get_title' ) ? $widget->get_title() : $name,
            'categories' => method_exists( $widget, 'get_categories' ) ? $widget->get_categories() : array(),
            'controls'   => $controls,
        );
    }
    return new WP_REST_Response( array( 'widgets' => $widgets, 'count' => count( $widgets ) ) );
}

/**
 * GET /elementor/data/{id}
 * Returns the decoded `_elementor_data` elements tree for a post, plus edit-mode
 * and version meta.
 */
function claude_elementor_data_get( $req ) {
    if ( ! class_exists( '\Elementor\Plugin' ) ) {
        return new WP_Error( 'elementor_missing', 'Elementor is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    $raw  = get_post_meta( $post_id, '_elementor_data', true );
    $data = $raw ? json_decode( $raw, true ) : array();
    return new WP_REST_Response( array(
        'post_id'   => $post_id,
        'elements'  => is_array( $data ) ? $data : array(),
        'edit_mode' => get_post_meta( $post_id, '_elementor_edit_mode', true ),
        'version'   => get_post_meta( $post_id, '_elementor_version', true ),
    ) );
}

/**
 * Recursively checks an Elementor elements tree and fills in any missing `id`
 * (Elementor requires a unique id per element; a hand-built tree is likely to
 * omit or duplicate these). Modifies $elements in place.
 *
 * @param array $elements
 * @return string|null Error message, or null on success.
 */
function claude_elementor_normalize_elements( array &$elements ) {
    foreach ( $elements as &$el ) {
        if ( ! is_array( $el ) ) {
            return 'Each element must be an object.';
        }
        if ( empty( $el['elType'] ) ) {
            return 'Each element requires an "elType" (e.g. "section", "column", "widget").';
        }
        if ( empty( $el['id'] ) ) {
            $el['id'] = substr( md5( uniqid( (string) wp_rand(), true ) ), 0, 7 );
        }
        if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
            $error = claude_elementor_normalize_elements( $el['elements'] );
            if ( $error ) {
                return $error;
            }
        }
    }
    return null;
}

/**
 * POST /elementor/data/{id}
 * Writes an Elementor elements tree to `_elementor_data` and sets the meta
 * Elementor needs to render it, then clears the CSS file cache so the change
 * shows up on the frontend without a manual "regenerate CSS".
 * Body: { "elements": [ { "id": "...", "elType": "section", "elements": [...] }, ... ] }
 * `id` may be omitted - missing ids are generated automatically.
 */
function claude_elementor_data_set( $req ) {
    if ( ! class_exists( '\Elementor\Plugin' ) ) {
        return new WP_Error( 'elementor_missing', 'Elementor is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    $body     = (array) $req->get_json_params();
    $elements = $body['elements'] ?? null;
    if ( ! is_array( $elements ) ) {
        return new WP_Error( 'missing', 'Body must include "elements" as an array.', array( 'status' => 400 ) );
    }
    $error = claude_elementor_normalize_elements( $elements );
    if ( $error ) {
        return new WP_Error( 'invalid_elements', $error, array( 'status' => 400 ) );
    }
    // wp_slash() here counteracts update_metadata()'s internal wp_unslash() call, which
    // would otherwise mangle backslash-escaped sequences inside the JSON (e.g. \" or \n)
    // before it's stored - the same pattern Elementor's own Document::save() uses.
    update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( $elements ) ) );
    update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );

    // Library items need a real template type (page/section/container...) and the
    // matching elementor_library_type term, or they don't show up in My Templates.
    $is_library    = get_post_type( $post_id ) === 'elementor_library';
    $template_type = sanitize_key( (string) ( $body['template_type'] ?? ( $is_library ? 'page' : 'wp-post' ) ) );
    update_post_meta( $post_id, '_elementor_template_type', $template_type );
    if ( $is_library && taxonomy_exists( 'elementor_library_type' ) ) {
        wp_set_object_terms( $post_id, $template_type, 'elementor_library_type' );
    }
    if ( defined( 'ELEMENTOR_VERSION' ) ) {
        update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );
    }

    // Page settings (hide_title, theme switches, page custom_css...) are merged, not
    // replaced, so writing one key can't wipe settings someone set in the editor.
    if ( isset( $body['page_settings'] ) && is_array( $body['page_settings'] ) ) {
        $current = get_post_meta( $post_id, '_elementor_page_settings', true );
        $merged  = array_merge( is_array( $current ) ? $current : array(), $body['page_settings'] );
        update_post_meta( $post_id, '_elementor_page_settings', wp_slash( $merged ) );
    }
    if ( ! empty( $body['page_template'] ) ) {
        update_post_meta( $post_id, '_wp_page_template', sanitize_text_field( $body['page_template'] ) );
    }

    if ( isset( \Elementor\Plugin::$instance->files_manager )
        && method_exists( \Elementor\Plugin::$instance->files_manager, 'clear_cache' ) ) {
        \Elementor\Plugin::$instance->files_manager->clear_cache();
    }

    $response = array( 'post_id' => $post_id, 'elements' => count( $elements ), 'template_type' => $template_type );
    $warnings = claude_elementor_lint( $elements );
    if ( $warnings ) $response['warnings'] = $warnings;
    return new WP_REST_Response( $response );
}

/**
 * Flags settings that save fine but render wrong - the class of mistake that only
 * shows up when someone looks at the page.
 *
 * @param array $elements
 * @return string[]
 */
function claude_elementor_lint( array $elements ) {
    $warnings = array();
    $walk     = function ( $els ) use ( &$walk, &$warnings ) {
        foreach ( $els as $el ) {
            if ( ! is_array( $el ) ) continue;
            $s  = is_array( $el['settings'] ?? null ) ? $el['settings'] : array();
            $id = $el['id'] ?? '?';
            if ( ( $el['widgetType'] ?? '' ) === 'image' && empty( $s['image']['url'] ) ) {
                $warnings[] = "Image widget {$id} has no image.url - Elementor renders nothing for it even when image.id is set. Pass both.";
            }
            if ( ! empty( $s['background_overlay_background'] ) && ! isset( $s['background_overlay_opacity'] ) ) {
                $warnings[] = "Element {$id} has a background overlay but no background_overlay_opacity - it renders at Elementor's default 50%, so the overlay looks washed out.";
            }
            if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) $walk( $el['elements'] );
        }
    };
    $walk( $elements );
    return array_slice( $warnings, 0, 50 );
}

/**
 * GET /elementor/kit
 * The site's design tokens from the active Elementor kit: global colours and
 * typography. Read these before designing so new layouts use the brand's own
 * values instead of approximations.
 */
function claude_elementor_kit() {
    if ( ! class_exists( '\Elementor\Plugin' ) ) {
        return new WP_Error( 'elementor_missing', 'Elementor is not active on this site.', array( 'status' => 422 ) );
    }
    $kit_id   = (int) get_option( 'elementor_active_kit' );
    $settings = $kit_id ? get_post_meta( $kit_id, '_elementor_page_settings', true ) : array();
    $settings = is_array( $settings ) ? $settings : array();

    $colors = array();
    foreach ( array( 'system_colors', 'custom_colors' ) as $group ) {
        foreach ( (array) ( $settings[ $group ] ?? array() ) as $c ) {
            if ( ! empty( $c['_id'] ) ) {
                $colors[] = array( 'id' => $c['_id'], 'title' => $c['title'] ?? '', 'color' => $c['color'] ?? '', 'group' => $group );
            }
        }
    }
    $typography = array();
    foreach ( array( 'system_typography', 'custom_typography' ) as $group ) {
        foreach ( (array) ( $settings[ $group ] ?? array() ) as $t ) {
            if ( empty( $t['_id'] ) ) continue;
            $entry = array( 'id' => $t['_id'], 'title' => $t['title'] ?? '', 'group' => $group );
            foreach ( $t as $k => $v ) {
                if ( strpos( $k, 'typography_' ) === 0 && $k !== 'typography_typography' && $v !== '' && $v !== array() ) {
                    $entry[ substr( $k, 11 ) ] = $v;
                }
            }
            $typography[] = $entry;
        }
    }
    return new WP_REST_Response( array(
        'kit_id'          => $kit_id,
        'colors'          => $colors,
        'typography'      => $typography,
        'container_width' => $settings['container_width'] ?? null,
        'breakpoints'     => array_values( array_filter( array_keys( $settings ), function ( $k ) { return strpos( $k, 'viewport_' ) === 0; } ) ),
        'usage'           => 'Global colours are referenced in element settings as __globals__ => { "<setting>": "globals/colors?id=<id>" }.',
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Divi
// ──────────────────────────────────────────────────────────────────────────────
//
// Divi has two generations with different content formats: classic Divi (D4)
// stores nested shortcodes directly in post_content; Divi 5 (D5) introduced a
// newer structured module model. Detection below is best-effort - it hasn't been
// verified against a live Divi 5 install, so treat `generation` in responses as
// informational and confirm against the actual site before relying on it.

// ──────────────────────────────────────────────────────────────────────────────
//  Rendered-page inspection
//
//  Every other endpoint reports database state. Several whole classes of defect
//  are only visible in the rendered output: kses corruption, a page falling
//  back to the wrong template, Divi CSS index mismatches, broken heading
//  structure. This closes that loop server-side, which also avoids the auth and
//  caching differences you get fetching the URL from a client machine.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL over loopback HTTP as an anonymous visitor, cache-busted.
 *
 * @param  string $url
 * @return string|WP_Error  Response body.
 */
function claude_fetch_rendered( $url ) {
    if ( ! $url ) {
        return new WP_Error( 'missing', 'No URL to fetch.', array( 'status' => 400 ) );
    }

    $res = wp_remote_get( add_query_arg( 'claude_cb', time(), $url ), array(
        'timeout'    => 30,
        'sslverify'  => false,   // staging hosts commonly have self-signed certs
        'cookies'    => array(), // render as a logged-out visitor
        'user-agent' => 'ClaudeConnector/' . CLAUDE_CONNECTOR_VERSION,
    ) );

    if ( is_wp_error( $res ) ) {
        return new WP_Error(
            'loopback_failed',
            'Could not fetch the page from the server. The host may block loopback '
            . 'HTTP requests. Underlying error: ' . $res->get_error_message(),
            array( 'status' => 502 )
        );
    }

    return (string) wp_remote_retrieve_body( $res );
}

/**
 * Cheap structural health summary of a rendered page.
 *
 * @param  string $html
 * @return array
 */
function claude_render_summary( $html ) {
    $headings = array();
    if ( preg_match_all( '/<h([1-6])[^>]*>(.*?)<\/h\1>/is', $html, $m, PREG_SET_ORDER ) ) {
        foreach ( array_slice( $m, 0, 40 ) as $h ) {
            $headings[] = 'h' . $h[1] . ': ' . trim( wp_strip_all_tags( $h[2] ) );
        }
    }

    return array(
        'title'            => preg_match( '/<title[^>]*>(.*?)<\/title>/is', $html, $m ) ? trim( wp_strip_all_tags( $m[1] ) ) : null,
        'meta_description' => preg_match( '/<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']/is', $html, $m ) ? $m[1] : null,
        'h1_count'         => preg_match_all( '/<h1[\s>]/i', $html ),
        'heading_outline'  => $headings,
        'sections'         => preg_match_all( '/et_pb_section[\s"\']/', $html ),
        'images'           => preg_match_all( '/<img[\s]/i', $html ),
        'images_no_alt'    => preg_match_all( '/<img(?![^>]*\salt=)[^>]*>/i', $html ),
        'empty_paragraphs' => preg_match_all( '/<p>\s*(?:&nbsp;)?\s*<\/p>/i', $html ),
        'kses_corruption'  => (bool) preg_match( '/&lt;!--\s*wp:/', $html ),
        'has_sidebar'      => (bool) preg_match( '/id=["\']sidebar["\']/', $html ),
        'bytes'            => strlen( $html ),
    );
}

/**
 * GET /render
 *
 * Params: id | url, include_html, expect (JSON object of summary assertions).
 */
function claude_page_render( $req ) {
    $id  = (int) ( $req->get_param( 'id' ) ?? 0 );
    $url = $id ? get_permalink( $id ) : (string) ( $req->get_param( 'url' ) ?? '' );

    if ( $id && ! $url ) {
        return new WP_Error( 'not_found', 'Post not found, or it has no permalink.', array( 'status' => 404 ) );
    }
    if ( ! $url ) {
        return new WP_Error( 'missing', 'Provide ?id= or ?url=.', array( 'status' => 400 ) );
    }

    $html = claude_fetch_rendered( $url );
    if ( is_wp_error( $html ) ) return $html;

    $summary  = claude_render_summary( $html );
    $response = array(
        'url'     => $url,
        'summary' => $summary,
    );

    // Optional assertions, so a check is one call instead of a fetch plus a read.
    $expect = $req->get_param( 'expect' );
    if ( is_string( $expect ) ) {
        $expect = json_decode( $expect, true );
    }
    if ( is_array( $expect ) && $expect ) {
        $failed = array();
        foreach ( $expect as $key => $want ) {
            if ( ! array_key_exists( $key, $summary ) ) {
                $failed[] = "{$key}: not a known summary field";
                continue;
            }
            $got = $summary[ $key ];
            // Loose compare so JSON true/false and 1/0 behave sensibly.
            if ( is_bool( $want ) ? ( (bool) $got !== $want ) : ( (string) $got !== (string) $want ) ) {
                $failed[] = sprintf(
                    '%s: expected %s, got %s',
                    $key,
                    var_export( $want, true ),
                    var_export( $got, true )
                );
            }
        }
        $response['ok']     = empty( $failed );
        $response['failed'] = $failed;
    }

    // Full HTML is opt-in: a rendered Divi page is routinely 100KB+ and the
    // summary usually answers the question on its own.
    if ( $req->get_param( 'include_html' ) ) {
        $response['html'] = $html;
    }

    return new WP_REST_Response( $response );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Block validation
//
//  Divi 5 stores module attributes as JSON inside HTML comments, so a single
//  unbalanced brace corrupts a page with no parse error - the module just
//  renders with defaults. These checks catch that class of damage cheaply, and
//  run automatically on every content write.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Inspect a post's block markup and report anything malformed.
 *
 * @param  int $post_id
 * @return array|WP_Error
 */
function claude_blocks_report( $post_id ) {
    $content = get_post_field( 'post_content', $post_id );
    if ( ! is_string( $content ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }

    $issues = array();

    if ( false !== strpos( $content, '&lt;!-- wp:' ) ) {
        $issues[] = array(
            'type'  => 'kses_corruption',
            'fatal' => true,
            'hint'  => 'Block delimiters were HTML-escaped on write. See claude_assume_user().',
        );
    }

    $blocks = parse_blocks( $content );

    // Validate each block's attribute JSON directly.
    //
    // parse_blocks() silently sets attrs to null when the JSON is malformed, so
    // a single unbalanced brace produces a module that renders with defaults and
    // reports nothing. Checking the JSON is exact; comparing
    // serialize_blocks(parse_blocks($c)) against $c is NOT a valid test, because
    // serialize_block_attributes() deliberately re-encodes the JSON - it escapes
    // "<" and "--" to their unicode forms so the result is safe inside an HTML
    // comment - which means perfectly valid content fails a round-trip
    // comparison. That check produced false positives and has been removed.
    if ( preg_match_all( '/<!--\s+wp:([a-z0-9\/-]+)\s+(\{.*?\})\s*\/?-->/is', $content, $m, PREG_SET_ORDER ) ) {
        foreach ( $m as $i => $match ) {
            json_decode( $match[2], true );
            if ( JSON_ERROR_NONE !== json_last_error() ) {
                $issues[] = array(
                    'type'    => 'invalid_attribute_json',
                    'block'   => $match[1],
                    'index'   => $i,
                    'error'   => json_last_error_msg(),
                    'excerpt' => substr( $match[2], 0, 200 ),
                );
            }
        }
    }

    // Delimiter balance, counted directly - a truncated write can leave an
    // opener without its closer, which parse_blocks() silently tolerates.
    $opens      = preg_match_all( '/<!--\s+wp:[a-z0-9\/-]+/i', $content );
    $closes     = preg_match_all( '/<!--\s+\/wp:[a-z0-9\/-]+/i', $content );
    $selfclose  = preg_match_all( '/<!--\s+wp:[a-z0-9\/-]+(?:\s+\{.*?\})?\s+\/-->/is', $content );
    if ( ( $opens - $selfclose ) !== $closes ) {
        $issues[] = array(
            'type'        => 'delimiter_imbalance',
            'open'        => $opens,
            'close'       => $closes,
            'self_closing'=> $selfclose,
            'hint'        => 'Unclosed block. Expected open-minus-self-closing to equal close.',
        );
    }

    $counts = array();
    $walk   = function ( $bs, $path ) use ( &$walk, &$issues, &$counts ) {
        foreach ( $bs as $i => $b ) {
            $name = $b['blockName'];

            if ( null === $name ) {
                if ( '' !== trim( (string) $b['innerHTML'] ) ) {
                    $issues[] = array(
                        'type'    => 'unparsed_or_freeform',
                        'path'    => $path . '/' . $i,
                        'excerpt' => substr( trim( (string) $b['innerHTML'] ), 0, 160 ),
                    );
                }
            } else {
                $counts[ $name ] = ( $counts[ $name ] ?? 0 ) + 1;
            }

            if ( ! empty( $b['innerBlocks'] ) ) {
                $walk( $b['innerBlocks'], $path . '/' . $i );
            }
        }
    };
    $walk( $blocks, '' );

    ksort( $counts );

    return array(
        'post_id'      => (int) $post_id,
        'valid'        => empty( $issues ),
        'block_counts' => $counts,
        'top_level'    => count( $blocks ),
        'bytes'        => strlen( $content ),
        'issues'       => $issues,
    );
}

/**
 * Every encoding a snippet of HTML might be stored in inside block markup.
 *
 * This exists because searching builder content for plain HTML does not work,
 * and the reason is genuinely confusing: block attributes are JSON embedded in
 * an HTML comment, so the HTML inside them is escaped - but *how* it is escaped
 * depends on what wrote it.
 *
 *   raw               <h1>Hi</h1>
 *                       plain text - a code module, or a non-block post
 *   json               \u0022 not used; quotes escaped as \\" , angle brackets left as-is
 *                       what you get from hand-written block JSON
 *   block_attr_mixed   angle brackets as \u003c / \u003e, quotes still \\"
 *                       seen in practice across Divi versions
 *   block_attr         angle brackets, ampersands, quotes and -- all escaped
 *                       to their \uXXXX forms - this is what WordPress's own
 *                       serialize_block_attributes() emits, and therefore what
 *                       the Divi 5 visual builder writes
 *
 * So the same heading can be sitting in the database in any of four forms, and
 * a find/replace has to try all of them. Callers should never have to know
 * this - they pass plain HTML and this works out the rest.
 *
 * @param  string $s
 * @return array  encoding name => encoded string
 */
function claude_content_encodings( $s ) {
    $out = array( 'raw' => $s );

    // JSON-encode, then drop the wrapping quotes, to get the form a string
    // takes inside a JSON document.
    $json = wp_json_encode( $s, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
    $json = ( is_string( $json ) && strlen( $json ) >= 2 ) ? substr( $json, 1, -1 ) : $s;
    $out['json'] = $json;

    // Angle brackets escaped but quotes left as \" .
    $mixed = str_replace( array( '<', '>' ), array( '\\u003c', '\\u003e' ), $json );
    $out['block_attr_mixed'] = $mixed;

    // The full serialize_block_attributes() treatment, in its own order.
    $attr = $json;
    $attr = str_replace( '--',  '\\u002d\\u002d', $attr );
    $attr = str_replace( '<',   '\\u003c', $attr );
    $attr = str_replace( '>',   '\\u003e', $attr );
    $attr = str_replace( '&',   '\\u0026', $attr );
    $attr = str_replace( '\\"', '\\u0022', $attr );
    $out['block_attr'] = $attr;

    return $out;
}

/**
 * POST /content/replace
 *
 * Find and replace inside post content, in plain HTML, without the caller
 * having to know how the builder escaped it (see claude_content_encodings()).
 *
 * Body: {
 *   search, replace,            - plain HTML / text
 *   id | ids | all_builder,     - target
 *   dry_run, resave, regex      - options
 * }
 */
function claude_content_replace( $req ) {
    $body    = (array) $req->get_json_params();
    $search  = (string) ( $body['search'] ?? '' );
    $replace = array_key_exists( 'replace', $body ) ? (string) $body['replace'] : null;

    if ( '' === $search || null === $replace ) {
        return new WP_Error( 'missing', 'Body must include "search" and "replace".', array( 'status' => 400 ) );
    }

    if ( ! empty( $body['id'] ) ) {
        $ids = array( (int) $body['id'] );
    } elseif ( ! empty( $body['ids'] ) && is_array( $body['ids'] ) ) {
        $ids = array_map( 'intval', $body['ids'] );
    } elseif ( ! empty( $body['all_builder'] ) ) {
        $ids = claude_divi_builder_post_ids( true );
    } else {
        return new WP_Error( 'missing', 'Provide "id", "ids", or "all_builder": true.', array( 'status' => 400 ) );
    }

    $dry      = ! empty( $body['dry_run'] );
    $s_vars   = claude_content_encodings( $search );
    $r_vars   = claude_content_encodings( $replace );
    $results  = array();
    $total    = 0;

    foreach ( $ids as $id ) {
        $content = get_post_field( 'post_content', $id );
        if ( ! is_string( $content ) ) continue;

        $new     = $content;
        $matched = array();
        $seen    = array();

        // Keys stay aligned between search and replace variants, so skipping a
        // duplicate needle cannot pair the wrong replacement with it.
        foreach ( $s_vars as $name => $needle ) {
            if ( '' === $needle || isset( $seen[ $needle ] ) ) continue;
            $seen[ $needle ] = true;

            $hits = substr_count( $new, $needle );
            if ( ! $hits ) continue;

            $matched[ $name ] = $hits;
            $total           += $hits;
            $new              = str_replace( $needle, $r_vars[ $name ], $new );
        }

        if ( ! $matched ) continue;

        $row = array(
            'post_id'      => $id,
            'slug'         => get_post_field( 'post_name', $id ),
            'matched'      => $matched,
            'bytes_before' => strlen( $content ),
            'bytes_after'  => strlen( $new ),
        );

        if ( ! $dry ) {
            wp_update_post( wp_slash( array( 'ID' => $id, 'post_content' => $new ) ) );

            if ( $err = claude_assert_blocks_survived( $id ) ) return $err;

            $report = claude_blocks_report( $id );
            if ( ! is_wp_error( $report ) ) {
                $row['blocks_valid']  = $report['valid'];
                $row['blocks_issues'] = $report['issues'];
            }

            // A direct content write leaves Divi's cached CSS stale.
            claude_divi_flush_post( $id );
            if ( ! empty( $body['resave'] ) ) {
                wp_update_post( array( 'ID' => $id ) );
            }
        }

        $results[] = $row;
    }

    $response = array(
        'dry_run'        => $dry,
        'posts_searched' => count( $ids ),
        'posts_matched'  => count( $results ),
        'total_matches'  => $total,
        'results'        => $results,
    );

    // Nothing matched: show what was actually looked for, so the caller can see
    // whether it is an encoding problem or the string genuinely is not there.
    if ( ! $total ) {
        $response['tried_encodings'] = $s_vars;
        $response['hint'] = 'None of the encodings matched. Check the string really is '
            . 'present - GET /divi/data/{id} returns the raw stored content.';
    }

    return new WP_REST_Response( $response );
}

/**
 * GET /blocks/validate/{id}
 */
function claude_blocks_validate( $req ) {
    $report = claude_blocks_report( (int) $req['id'] );
    if ( is_wp_error( $report ) ) return $report;
    return new WP_REST_Response( $report );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Divi
// ──────────────────────────────────────────────────────────────────────────────

function claude_divi_active() {
    return class_exists( 'ET_Builder_Element' ) || defined( 'ET_CORE_VERSION' ) || function_exists( 'et_setup_theme' );
}

function claude_divi_generation() {
    if ( defined( 'ET_BUILDER_PRODUCT_VERSION' ) && version_compare( ET_BUILDER_PRODUCT_VERSION, '5.0', '>=' ) ) {
        return 'd5_json';
    }
    return 'd4_shortcode';
}

/**
 * Divi 5 ships its full module schema as a generated PHP file that returns an
 * array keyed by module slug (name, title, category, d4Shortcode, attributes...).
 * Works for the Divi theme and for the Divi Builder plugin.
 *
 * @return array|null
 */
function claude_divi5_metadata() {
    static $cache = null;
    if ( $cache !== null ) return $cache ?: null;
    $candidates = array( get_template_directory() . '/includes/builder-5/server/_all_modules_metadata.php' );
    if ( defined( 'ET_BUILDER_DIR' ) ) {
        $candidates[] = dirname( rtrim( ET_BUILDER_DIR, '/\\' ) ) . '/builder-5/server/_all_modules_metadata.php';
    }
    foreach ( $candidates as $file ) {
        if ( is_readable( $file ) ) {
            $data  = include $file;
            $cache = is_array( $data ) ? $data : array();
            return $cache ?: null;
        }
    }
    $cache = array();
    return null;
}

/**
 * Flattens one Divi 5 module's metadata into the attribute paths you write in
 * block JSON, e.g. button.innerContent, module.advanced.htmlAttributes.
 *
 * @param array $module
 * @return array
 */
function claude_divi5_module_schema( array $module ) {
    $groups = array();
    foreach ( (array) ( $module['attributes'] ?? array() ) as $group => $def ) {
        if ( ! is_array( $def ) ) continue;
        $paths = array();
        foreach ( (array) ( $def['settings'] ?? array() ) as $area => $items ) {
            if ( $area === 'meta' ) continue;
            if ( $area === 'innerContent' ) {
                $paths[] = "{$group}.innerContent";
                continue;
            }
            if ( is_array( $items ) ) {
                foreach ( array_keys( $items ) as $k ) {
                    $paths[] = "{$group}.{$area}.{$k}";
                }
            }
        }
        $groups[] = array(
            'group'        => $group,
            'element_type' => $def['elementType'] ?? null,
            'selector'     => $def['selector'] ?? null,
            'paths'        => $paths,
            'default'      => $def['default'] ?? null,
        );
    }
    return array(
        'name'          => $module['name'] ?? '',
        'title'         => $module['title'] ?? '',
        'category'      => $module['category'] ?? '',
        'd4_shortcode'  => $module['d4Shortcode'] ?? null,
        'children'      => $module['childrenName'] ?? array(),
        'groups'        => $groups,
        'custom_css'    => array_keys( (array) ( $module['customCssFields'] ?? array() ) ),
        'notes'         => 'Every leaf is written per breakpoint: {"desktop":{"value":...}}. Read a page built in the Divi UI for real value shapes; unknown paths are dropped silently. These are the settings-panel groups, not every storage path: the CSS class/ID lives at module.advanced.htmlAttributes.desktop.value.{class,id}.',
    );
}

/**
 * GET /divi/modules[?name=divi/button]
 * Divi 5: every module from Divi's own schema; pass ?name= for one module's
 * attribute paths. Divi 4: the ET_Builder_Element registry.
 */
function claude_divi_modules( $req = null ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }
    $generation = claude_divi_generation();
    if ( $generation === 'd5_json' && ( $meta = claude_divi5_metadata() ) ) {
        $name = $req ? (string) $req->get_param( 'name' ) : '';
        if ( $name !== '' ) {
            $slug = preg_replace( '#^divi/#', '', sanitize_text_field( $name ) );
            if ( ! isset( $meta[ $slug ] ) ) {
                return new WP_Error( 'not_found', "No Divi 5 module named divi/{$slug}.", array( 'status' => 404 ) );
            }
            return new WP_REST_Response( array( 'generation' => $generation, 'module' => claude_divi5_module_schema( $meta[ $slug ] ) ) );
        }
        $modules = array();
        foreach ( $meta as $slug => $m ) {
            $modules[] = array(
                'name'         => $m['name'] ?? "divi/{$slug}",
                'title'        => $m['title'] ?? $slug,
                'category'     => $m['category'] ?? '',
                'd4_shortcode' => $m['d4Shortcode'] ?? null,
                'groups'       => array_keys( (array) ( $m['attributes'] ?? array() ) ),
            );
        }
        return new WP_REST_Response( array( 'generation' => $generation, 'count' => count( $modules ), 'modules' => $modules ) );
    }
    if ( $generation === 'd4_shortcode' && class_exists( 'ET_Builder_Element' ) && method_exists( 'ET_Builder_Element', 'get_modules' ) ) {
        $modules = array();
        foreach ( ET_Builder_Element::get_modules() as $slug => $module ) {
            $modules[] = array(
                'slug' => $slug,
                'name' => method_exists( $module, 'get_name' ) ? $module->get_name() : $slug,
            );
        }
        return new WP_REST_Response( array( 'generation' => $generation, 'modules' => $modules ) );
    }
    return new WP_REST_Response( array(
        'generation' => $generation,
        'modules'    => array(),
        'note'       => 'Could not find _all_modules_metadata.php from Divi 5 (theme or Divi Builder plugin). Read a page built in the Divi UI with wp_divi_data_get for attribute shapes instead.',
    ) );
}

/**
 * GET /divi/data/{id}
 * Returns the current builder content (post_content) plus Divi meta for a post.
 */
function claude_divi_data_get( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    $post    = get_post( $post_id );
    if ( ! $post ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    return new WP_REST_Response( array(
        'post_id'         => $post_id,
        'generation'      => claude_divi_generation(),
        'use_builder'     => get_post_meta( $post_id, '_et_pb_use_builder', true ),
        'builder_version' => get_post_meta( $post_id, '_et_builder_version', true ),
        'content'         => $post->post_content,
    ) );
}

/**
 * POST /divi/data/{id}
 * Writes builder content for a post. `content` is opaque from the API's point of
 * view - the caller is responsible for sending the right shape for this site's
 * Divi generation (shortcode markup for D4, module JSON for D5).
 * Body: { "content": "..." }
 */
function claude_divi_data_set( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }
    $body    = (array) $req->get_json_params();
    $content = $body['content'] ?? null;
    if ( ! is_string( $content ) || $content === '' ) {
        return new WP_Error( 'missing', 'Body must include "content" as a non-empty string.', array( 'status' => 400 ) );
    }
    // wp_update_post() expects pre-slashed input - see claude_posts_create().
    wp_update_post( wp_slash( array( 'ID' => $post_id, 'post_content' => $content ) ) );

    $generation = claude_divi_generation();

    if ( 'd5_json' === $generation ) {
        // Divi 5 needs the full meta set, not just _et_pb_use_builder, or the
        // page renders on the theme's default template with a widget sidebar.
        $meta_written = claude_divi5_apply_meta( $post_id, (bool) ( $body['force_meta'] ?? false ) );
    } else {
        update_post_meta( $post_id, '_et_pb_use_builder', 'on' );
        $meta_written = array( '_et_pb_use_builder' );
        if ( defined( 'ET_BUILDER_PRODUCT_VERSION' ) ) {
            update_post_meta( $post_id, '_et_builder_version', ET_BUILDER_PRODUCT_VERSION );
            $meta_written[] = '_et_builder_version';
        }
    }

    // Fail loudly rather than leaving a corrupted layout behind.
    if ( claude_has_blocks( $content ) ) {
        if ( $err = claude_assert_blocks_survived( $post_id ) ) return $err;
    }

    $response = array(
        'post_id'      => $post_id,
        'generation'   => $generation,
        'meta_written' => $meta_written,
    );

    if ( claude_has_blocks( $content ) ) {
        $report = claude_blocks_report( $post_id );
        if ( ! is_wp_error( $report ) ) $response['blocks'] = $report;
    }

    // Divi regenerates per-post CSS on save. Invalidate the caches that a
    // direct write leaves stale, unless the caller opts out.
    if ( empty( $body['skip_cache_flush'] ) ) {
        claude_divi_flush_post( $post_id );
        $response['cache_flushed'] = true;
    }

    return new WP_REST_Response( $response );
}

/**
 * Invalidate Divi's cached CSS for one post.
 *
 * Divi caches per-post CSS in wp-content/et-cache/<id>/ and in
 * _divi_dynamic_assets_cached_* postmeta. Neither is invalidated by a direct
 * SQL or wp_update_post() write, so the page keeps serving stale styles and you
 * conclude your edit did not work.
 *
 * @param int $post_id
 */
function claude_divi_flush_post( $post_id ) {
    global $wpdb;

    $wpdb->query( $wpdb->prepare(
        "DELETE FROM {$wpdb->postmeta}
         WHERE post_id = %d AND meta_key LIKE %s",
        $post_id,
        '_divi_dynamic_assets_cached%'
    ) );

    if ( class_exists( 'ET_Core_PageResource' ) && method_exists( 'ET_Core_PageResource', 'remove_static_resources' ) ) {
        ET_Core_PageResource::remove_static_resources( $post_id, 'all' );
    }
}

/**
 * Divi's internal builder post types - Theme Builder templates, the library,
 * and its prerender/speculation helper posts.
 *
 * These hold builder markup but are not pages: they have no public permalink
 * and page-level layout meta (_et_pb_page_layout, _et_pb_side_nav) does not
 * apply to them, so auditing them produces nothing but false positives.
 */
function claude_divi_internal_post_types() {
    return array(
        'et_header_layout', 'et_body_layout', 'et_footer_layout',
        'et_theme_builder_layout', 'et_template', 'et_pb_layout',
        '_et_pb_speculation',
    );
}

/**
 * Every published post whose content is Divi builder markup, either generation.
 *
 * @param  bool $include_internal  Also return Theme Builder templates and the
 *                                 library. Useful for a CSS-regenerating
 *                                 re-save, wrong for an audit.
 * @return int[]
 */
function claude_divi_builder_post_ids( $include_internal = false ) {
    global $wpdb;

    $types = array_values( get_post_types( array( 'public' => true ) ) );
    $types = array_diff( $types, array( 'attachment' ) );

    if ( $include_internal ) {
        $types = array_merge( $types, claude_divi_internal_post_types() );
    }
    $types = array_values( array_unique( $types ) );
    if ( ! $types ) return array();

    $placeholders = implode( ', ', array_fill( 0, count( $types ), '%s' ) );

    $sql = $wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts}
         WHERE post_status = 'publish'
           AND post_type IN ( {$placeholders} )
           AND ( post_content LIKE %s OR post_content LIKE %s )
         ORDER BY ID ASC",
        array_merge( $types, array( '%<!-- wp:divi/%', '%[et_pb_section%' ) )
    ); // phpcs:ignore

    return array_map( 'intval', $wpdb->get_col( $sql ) ); // phpcs:ignore
}

/**
 * GET /divi/audit
 *
 * Two checks that between them cover the failure modes that are invisible from
 * the database:
 *
 *   1. Builder content with missing postmeta - the page renders on the theme's
 *      default template (widget sidebar, duplicated title) even though
 *      post_content is correct.
 *
 *   2. Divi's generated per-module CSS not matching the rendered markup.
 *      Installing or updating a plugin invalidates Divi's caches, and the
 *      regeneration can emit selectors whose indices are offset by the page's
 *      own module count - the stylesheet targets .et_pb_text_0 while the markup
 *      renders .et_pb_text_12. The result is that no Divi-attribute styling
 *      applies anywhere on the site, with nothing wrong in the database.
 *      The remedy is POST /divi/resave.
 */
function claude_divi_audit( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }

    $generation = claude_divi_generation();
    $ids        = claude_divi_builder_post_ids();

    // ---- 1. missing builder meta -------------------------------------------
    //
    // Only two of the five keys actually break a page when absent. Divi falls
    // back to sensible defaults for the three layout keys, so reporting those
    // at the same severity produces noise on pages that render perfectly well.
    $critical = ( 'd5_json' === $generation )
        ? array( '_et_pb_use_builder', '_et_pb_use_divi_5' )
        : array( '_et_pb_use_builder' );

    $advisory = array_values( array_diff( array_keys( CLAUDE_DIVI5_META ), $critical ) );

    $missing_meta  = array();
    $advisory_meta = array();

    foreach ( $ids as $id ) {
        $absent_critical = array();
        foreach ( $critical as $key ) {
            if ( '' === (string) get_post_meta( $id, $key, true ) ) {
                $absent_critical[] = $key;
            }
        }
        if ( $absent_critical ) {
            $missing_meta[] = array(
                'post_id' => $id,
                'slug'    => get_post_field( 'post_name', $id ),
                'missing' => $absent_critical,
                'effect'  => 'Renders on the theme default template instead of the builder layout.',
            );
            continue;
        }

        if ( 'd5_json' !== $generation ) continue;

        $absent_advisory = array();
        foreach ( $advisory as $key ) {
            if ( '' === (string) get_post_meta( $id, $key, true ) ) {
                $absent_advisory[] = $key;
            }
        }
        if ( $absent_advisory ) {
            $advisory_meta[] = array(
                'post_id' => $id,
                'slug'    => get_post_field( 'post_name', $id ),
                'missing' => $absent_advisory,
            );
        }
    }

    // ---- 2. CSS index check on a sample ------------------------------------
    $sample_size = max( 0, min( 25, (int) ( $req->get_param( 'css_sample' ) ?? 5 ) ) );
    $css_checked = array();

    foreach ( array_slice( $ids, 0, $sample_size ) as $id ) {
        $check = claude_divi_css_index_check( $id );
        if ( ! is_wp_error( $check ) ) {
            $css_checked[] = $check;
        }
    }

    $css_mismatched = array_values( array_filter( $css_checked, function ( $c ) {
        return ! $c['ok'];
    } ) );

    return new WP_REST_Response( array(
        'generation'         => $generation,
        'builder_posts'      => count( $ids ),
        'critical_meta'      => $critical,
        'missing_meta'       => $missing_meta,
        'missing_meta_count' => count( $missing_meta ),
        // Absent layout defaults. Harmless on their own - listed so you can
        // normalise them if you want to, not because anything is broken.
        'advisory_meta'      => $advisory_meta,
        'advisory_count'     => count( $advisory_meta ),
        'css_checked'        => $css_checked,
        'css_mismatched'     => $css_mismatched,
        'healthy'            => empty( $missing_meta ) && empty( $css_mismatched ),
        'remedy'             => ( $missing_meta || $css_mismatched )
            ? 'POST /divi/resave re-saves every builder post, which rewrites the '
              . 'builder meta and forces Divi to regenerate its CSS cleanly.'
            : null,
    ) );
}

/**
 * Compare the module indices in Divi's generated CSS for one post against the
 * indices actually present in its rendered markup.
 *
 * @param  int $post_id
 * @return array|WP_Error
 */
function claude_divi_css_index_check( $post_id ) {
    $html = claude_fetch_rendered( get_permalink( $post_id ) );
    if ( is_wp_error( $html ) ) return $html;

    // Classes present in the markup.
    $in_markup = array();
    if ( preg_match_all( '/class=["\']([^"\']*)["\']/', $html, $m ) ) {
        foreach ( $m[1] as $attr ) {
            foreach ( preg_split( '/\s+/', $attr ) as $cls ) {
                if ( preg_match( '/^et_pb_[a-z0-9_]+_\d+$/', $cls ) ) {
                    $in_markup[ $cls ] = true;
                }
            }
        }
    }

    // Selectors Divi emitted, from inline <style> blocks plus its own
    // stylesheets. Only Divi's own CSS is considered - a theme or plugin may
    // legitimately reference indices that are not on this page.
    $css = '';
    if ( preg_match_all( '/<style[^>]*>(.*?)<\/style>/is', $html, $m ) ) {
        $css .= implode( "\n", $m[1] );
    }
    if ( preg_match_all( '/<link[^>]+href=["\']([^"\']*(?:et-cache|et-core|et-divi|et_builder)[^"\']*)["\']/i', $html, $m ) ) {
        foreach ( array_slice( array_unique( $m[1] ), 0, 6 ) as $href ) {
            $sheet = wp_remote_get( $href, array( 'timeout' => 15, 'sslverify' => false ) );
            if ( ! is_wp_error( $sheet ) ) {
                $css .= "\n" . wp_remote_retrieve_body( $sheet );
            }
        }
    }

    $in_css = array();
    if ( preg_match_all( '/\.(et_pb_[a-z0-9_]+_\d+)/', $css, $m ) ) {
        foreach ( $m[1] as $cls ) {
            $in_css[ $cls ] = true;
        }
    }

    // Group both sides into module-type => set-of-indices.
    //
    // A plain "selector in CSS but not in markup" test is far too noisy to be
    // useful: Divi's global stylesheet carries column-fraction utility classes
    // (et_pb_column_1_2, et_pb_column_2_3, ...) and rules for modules used
    // elsewhere on the site, none of which appear in this page's markup.
    //
    // The offset bug has a much more specific fingerprint. For a given module
    // type the two index sets become entirely DISJOINT - the CSS styles
    // et_pb_text_0..11 while the markup rendered et_pb_text_12..23. Normal
    // pages always overlap. So only flag a module type that is present in the
    // markup, has CSS rules, and shares not a single index with them.
    $split = function ( $classes ) {
        $out = array();
        foreach ( array_keys( $classes ) as $cls ) {
            $pos = strrpos( $cls, '_' );
            if ( false === $pos ) continue;
            $type  = substr( $cls, 0, $pos );
            $index = substr( $cls, $pos + 1 );
            if ( ! is_numeric( $index ) ) continue;
            $out[ $type ][ (int) $index ] = true;
        }
        return $out;
    };

    $css_types    = $split( $in_css );
    $markup_types = $split( $in_markup );

    $mismatches = array();
    foreach ( $markup_types as $type => $markup_idx ) {
        if ( empty( $css_types[ $type ] ) ) {
            continue; // module type present but unstyled - not a mismatch
        }
        $css_idx = $css_types[ $type ];
        if ( array_intersect_key( $css_idx, $markup_idx ) ) {
            continue; // indices overlap - healthy
        }
        $mismatches[] = array(
            'module'        => $type,
            'css_indices'   => array_slice( array_keys( $css_idx ), 0, 12 ),
            'markup_indices'=> array_slice( array_keys( $markup_idx ), 0, 12 ),
        );
    }

    return array(
        'post_id'           => (int) $post_id,
        'slug'              => get_post_field( 'post_name', $post_id ),
        'markup_selectors'  => count( $in_markup ),
        'css_selectors'     => count( $in_css ),
        'module_types'      => count( $markup_types ),
        'mismatched_modules'=> $mismatches,
        'ok'                => empty( $mismatches ),
    );
}

/**
 * POST /divi/meta/{id}
 *
 * Applies the builder postmeta to an existing post without touching its
 * content. Use this to repair a page that was created through a route which did
 * not set it, and is therefore rendering on the theme's default template.
 *
 * Body: { "force": true }  - also overwrite existing layout choices.
 */
/**
 * POST /divi/library
 * Saves a layout to the Divi Library (et_pb_layout) with the terms and meta the
 * library needs to list and load it. A library item affects nothing until someone
 * loads it into a page, so this is the safe way to hand a design over.
 * Body: { "title": "...", "content": "<!-- wp:divi/... -->", "layout_type": "layout|section|row|module", "id": optional existing item }
 */
function claude_divi_library_save( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }
    $body    = (array) $req->get_json_params();
    $content = $body['content'] ?? null;
    $title   = sanitize_text_field( (string) ( $body['title'] ?? '' ) );
    $type    = sanitize_key( (string) ( $body['layout_type'] ?? 'layout' ) );
    if ( ! is_string( $content ) || $content === '' || $title === '' ) {
        return new WP_Error( 'missing', 'Body must include "title" and "content".', array( 'status' => 400 ) );
    }
    if ( ! in_array( $type, array( 'layout', 'section', 'row', 'module' ), true ) ) {
        return new WP_Error( 'bad_type', 'layout_type must be layout, section, row or module.', array( 'status' => 400 ) );
    }
    $existing = (int) ( $body['id'] ?? 0 );
    if ( $existing && get_post_type( $existing ) !== 'et_pb_layout' ) {
        return new WP_Error( 'bad_id', 'id is not a Divi Library item.', array( 'status' => 400 ) );
    }
    $postarr = array( 'post_type' => 'et_pb_layout', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => $content );
    if ( $existing ) $postarr['ID'] = $existing;
    // Pre-slashed for the same reason as claude_posts_create().
    $id = $existing ? wp_update_post( wp_slash( $postarr ), true ) : wp_insert_post( wp_slash( $postarr ), true );
    if ( is_wp_error( $id ) ) return $id;

    update_post_meta( $id, '_et_pb_use_builder', 'on' );
    update_post_meta( $id, '_et_pb_built_for_post_type', 'page' );
    if ( claude_divi_generation() === 'd5_json' ) {
        update_post_meta( $id, '_et_pb_use_divi_5', 'on' );
    }
    if ( taxonomy_exists( 'layout_type' ) )  wp_set_object_terms( $id, $type, 'layout_type' );
    if ( taxonomy_exists( 'scope' ) )        wp_set_object_terms( $id, 'not_global', 'scope' );
    if ( taxonomy_exists( 'module_width' ) ) wp_set_object_terms( $id, 'regular', 'module_width' );

    $response = array( 'id' => $id, 'title' => $title, 'layout_type' => $type );
    if ( claude_has_blocks( $content ) ) {
        if ( $err = claude_assert_blocks_survived( $id ) ) return $err;
        $report = claude_blocks_report( $id );
        if ( ! is_wp_error( $report ) ) $response['blocks'] = $report;
    }
    return new WP_REST_Response( $response, $existing ? 200 : 201 );
}

function claude_divi_meta_set( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }
    $post_id = (int) $req['id'];
    if ( ! get_post( $post_id ) ) {
        return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    }

    $body    = (array) $req->get_json_params();
    $written = claude_divi5_apply_meta( $post_id, (bool) ( $body['force'] ?? false ) );

    claude_divi_flush_post( $post_id );
    wp_update_post( array( 'ID' => $post_id ) );   // regenerate CSS with the new template

    return new WP_REST_Response( array(
        'post_id'      => $post_id,
        'generation'   => claude_divi_generation(),
        'meta_written' => $written,
        'meta'         => array_map(
            function ( $k ) use ( $post_id ) { return get_post_meta( $post_id, $k, true ); },
            array_combine( array_keys( CLAUDE_DIVI5_META ), array_keys( CLAUDE_DIVI5_META ) )
        ),
    ) );
}

/**
 * POST /divi/resave
 *
 * Re-saves builder posts so Divi regenerates their CSS. This is the standing
 * remedy for the module-index mismatch described in claude_divi_audit(), and
 * the required follow-up after editing post_content with raw SQL.
 *
 * Body: { "ids": [1,2,3] }  - omit to re-save every builder post.
 */
function claude_divi_resave( $req ) {
    if ( ! claude_divi_active() ) {
        return new WP_Error( 'divi_missing', 'Divi is not active on this site.', array( 'status' => 422 ) );
    }

    $body = (array) $req->get_json_params();
    // Re-saving the Theme Builder templates too is harmless and regenerates
    // their CSS as well, so the resave path includes them.
    $ids  = ! empty( $body['ids'] ) && is_array( $body['ids'] )
        ? array_map( 'intval', $body['ids'] )
        : claude_divi_builder_post_ids( true );

    $resaved = array();
    foreach ( $ids as $id ) {
        if ( ! get_post( $id ) ) continue;
        claude_divi_flush_post( $id );
        wp_update_post( array( 'ID' => $id ) );   // triggers CSS regeneration
        $resaved[] = $id;
    }

    return new WP_REST_Response( array(
        'resaved'       => count( $resaved ),
        'ids'           => $resaved,
        'next'          => 'Run GET /divi/audit to confirm the CSS indices now match.',
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Cache
// ──────────────────────────────────────────────────────────────────────────────

function claude_cache_purge( $req = null ) {
    $opts   = ( $req && method_exists( $req, 'get_json_params' ) ) ? (array) $req->get_json_params() : array();
    $purged = array();
    wp_cache_flush();
    $purged[] = 'wp_object_cache';

    global $wpdb;
    $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_%' OR option_name LIKE '\_site\_transient\_%'" );
    $purged[] = 'transients';

    if ( class_exists( 'WpeCommon' ) ) {
        if ( method_exists( 'WpeCommon', 'purge_memcached' ) )     WpeCommon::purge_memcached();
        if ( method_exists( 'WpeCommon', 'clear_maxcdn_cache' ) )  WpeCommon::clear_maxcdn_cache();
        if ( method_exists( 'WpeCommon', 'purge_varnish_cache' ) ) WpeCommon::purge_varnish_cache();
        $purged[] = 'wpe_page_cache';
    }
    if ( function_exists( 'w3tc_flush_all' ) )       { w3tc_flush_all();          $purged[] = 'w3tc'; }
    if ( function_exists( 'wp_cache_clear_cache' ) ) { wp_cache_clear_cache();    $purged[] = 'wp_super_cache'; }
    if ( function_exists( 'rocket_clean_domain' ) )  { rocket_clean_domain();     $purged[] = 'wp_rocket'; }
    if ( class_exists( 'LiteSpeed_Cache_API' ) )     { LiteSpeed_Cache_API::purge_all(); $purged[] = 'litespeed'; }

    // Page-builder caches. These live outside the object cache and are NOT
    // invalidated by a raw SQL write, so the page keeps serving stale CSS.
    if ( ! empty( $opts['builder'] ) ) {
        global $wpdb;

        if ( class_exists( 'ET_Core_PageResource' ) && method_exists( 'ET_Core_PageResource', 'remove_static_resources' ) ) {
            ET_Core_PageResource::remove_static_resources( 'all', 'all' );
            $purged[] = 'divi_static_resources';
        }
        if ( function_exists( 'et_core_clear_wp_cache' ) ) {
            et_core_clear_wp_cache();
            $purged[] = 'divi_core_cache';
        }
        $removed = $wpdb->query(
            "DELETE FROM {$wpdb->postmeta} WHERE meta_key LIKE '_divi_dynamic_assets_cached%'"
        );
        if ( $removed ) $purged[] = 'divi_dynamic_assets_meta:' . (int) $removed;

        if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
            \Elementor\Plugin::$instance->files_manager->clear_cache();
            $purged[] = 'elementor_css';
        }
    }

    // Clearing the caches is not always enough on Divi: regeneration can emit
    // module indices that do not match the rendered markup until each post is
    // re-saved. See claude_divi_audit().
    if ( ! empty( $opts['resave_builder_posts'] ) && claude_divi_active() ) {
        $ids = claude_divi_builder_post_ids();
        foreach ( $ids as $id ) {
            wp_update_post( array( 'ID' => $id ) );
        }
        $purged[] = 'resaved_builder_posts:' . count( $ids );
    }

    return new WP_REST_Response( array( 'purged' => $purged ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Posts
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @param WP_Post $p
 * @return array
 */
function claude_format_post( $p ) {
    return array(
        'id'         => $p->ID,
        'title'      => $p->post_title,
        'slug'       => $p->post_name,
        'status'     => $p->post_status,
        'type'       => $p->post_type,
        'date'       => $p->post_date,
        'modified'   => $p->post_modified,
        'permalink'  => get_permalink( $p->ID ),
        'excerpt'    => $p->post_excerpt,
        'content'    => $p->post_content,
        'author'     => (int) $p->post_author,
        'parent'     => (int) $p->post_parent,
        'menu_order' => (int) $p->menu_order,
    );
}

function claude_posts_list( $req ) {
    $args = array(
        'post_type'      => sanitize_key( $req->get_param( 'type' )     ?: 'post' ),
        'post_status'    => sanitize_text_field( $req->get_param( 'status' )   ?: 'any' ),
        'posts_per_page' => min( (int) ( $req->get_param( 'per_page' ) ?: 20 ), 100 ),
        'paged'          => max( (int) ( $req->get_param( 'page' )     ?: 1  ), 1  ),
        's'              => sanitize_text_field( $req->get_param( 'search' ) ?: '' ),
        'orderby'        => sanitize_key( $req->get_param( 'orderby' ) ?: 'date' ),
        'order'          => strtoupper( (string) $req->get_param( 'order' ) ) === 'ASC' ? 'ASC' : 'DESC',
    );
    if ( $tax = $req->get_param( 'taxonomy' ) ) {
        $args['tax_query'] = array( array(
            'taxonomy' => sanitize_key( $tax ),
            'field'    => 'slug',
            'terms'    => sanitize_text_field( (string) $req->get_param( 'term' ) ),
        ) );
    }
    $query = new WP_Query( $args );
    return new WP_REST_Response( array(
        'posts'    => array_map( 'claude_format_post', $query->posts ),
        'total'    => $query->found_posts,
        'pages'    => $query->max_num_pages,
        'per_page' => $args['posts_per_page'],
        'current'  => $args['paged'],
    ) );
}

function claude_posts_get( $req ) {
    $post = get_post( (int) $req['id'] );
    if ( ! $post ) return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    $data          = claude_format_post( $post );
    $data['meta']  = get_post_meta( $post->ID );
    $data['terms'] = wp_get_object_terms( $post->ID, get_object_taxonomies( $post->post_type ) );
    return new WP_REST_Response( $data );
}

function claude_posts_create( $req ) {
    $allowed = array( 'post_title', 'post_content', 'post_excerpt', 'post_status',
                      'post_type', 'post_name', 'post_author', 'menu_order',
                      'post_parent', 'page_template', 'comment_status', 'meta_input', 'post_password' );
    $data    = array_intersect_key( (array) $req->get_json_params(), array_flip( $allowed ) );
    if ( empty( $data['post_title'] ) && empty( $data['post_content'] ) ) {
        return new WP_Error( 'missing', 'post_title or post_content is required.', array( 'status' => 400 ) );
    }
    // wp_insert_post() calls wp_unslash() internally and expects pre-slashed input,
    // same as update_post_meta() - without this, literal backslashes in content or
    // meta_input values (Windows paths, regex, escaped quotes) get silently stripped.
    $id = wp_insert_post( wp_slash( $data ), true );
    if ( is_wp_error( $id ) ) return $id;

    $content  = (string) ( $data['post_content'] ?? '' );
    $response = claude_format_post( get_post( $id ) );
    $notes    = array();

    if ( claude_has_blocks( $content ) ) {
        if ( $err = claude_assert_blocks_survived( $id ) ) return $err;

        // A new page carrying Divi 5 blocks needs the builder postmeta or it
        // renders on the theme's default template instead. Infer it rather than
        // making the caller remember five meta keys.
        if ( claude_has_divi5_blocks( $content ) && claude_divi_active() ) {
            $written = claude_divi5_apply_meta( $id );
            $notes[] = 'Detected Divi 5 blocks; applied builder postmeta (' . implode( ', ', $written ) . ').';
        }

        $report = claude_blocks_report( $id );
        if ( ! is_wp_error( $report ) ) $response['blocks'] = $report;
    }

    if ( $notes ) $response['notes'] = $notes;

    return new WP_REST_Response( $response, 201 );
}

function claude_posts_update( $req ) {
    $post = get_post( (int) $req['id'] );
    if ( ! $post ) return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    $allowed    = array( 'post_title', 'post_content', 'post_excerpt', 'post_status',
                         'post_name', 'menu_order', 'page_template', 'comment_status', 'meta_input', 'post_password' );
    $data       = array_intersect_key( (array) $req->get_json_params(), array_flip( $allowed ) );
    $data['ID'] = $post->ID;
    // See claude_posts_create() - wp_update_post() expects pre-slashed input too.
    $id         = wp_update_post( wp_slash( $data ), true );
    if ( is_wp_error( $id ) ) return $id;

    $response = claude_format_post( get_post( $id ) );
    $notes    = array();

    if ( array_key_exists( 'post_content', $data ) && claude_has_blocks( $data['post_content'] ) ) {
        if ( $err = claude_assert_blocks_survived( $id ) ) return $err;

        if ( claude_has_divi5_blocks( $data['post_content'] ) && claude_divi_active() ) {
            $written = claude_divi5_apply_meta( $id );
            if ( $written ) {
                $notes[] = 'Detected Divi 5 blocks; asserted builder postmeta (' . implode( ', ', $written ) . ').';
            }
        }

        $report = claude_blocks_report( $id );
        if ( ! is_wp_error( $report ) ) $response['blocks'] = $report;
    }

    if ( $notes ) $response['notes'] = $notes;

    return new WP_REST_Response( $response );
}

function claude_posts_delete( $req ) {
    $post = get_post( (int) $req['id'] );
    if ( ! $post ) return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    $result = wp_delete_post( $post->ID, (bool) $req->get_param( 'force' ) );
    if ( ! $result ) return new WP_Error( 'delete_failed', 'Could not delete post.', array( 'status' => 500 ) );
    return new WP_REST_Response( array( 'deleted' => true, 'id' => $post->ID ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Options
// ──────────────────────────────────────────────────────────────────────────────

function claude_blocked_options() {
    return array(
        'siteurl', 'home', 'admin_email', 'blogname', 'blogdescription',
        'users_can_register', 'default_role', 'claude_connector_api_key',
        'auth_key', 'secure_auth_key', 'logged_in_key', 'nonce_key',
        'auth_salt', 'secure_auth_salt', 'logged_in_salt', 'nonce_salt',
        'active_plugins', 'template', 'stylesheet',
    );
}

/**
 * Walk a dotted path into a serialised option value.
 *
 * Themes routinely bury dozens of settings inside one serialised array - Divi
 * keeps divi_integration_head inside et_divi, for example - so a flat
 * get_option() returns false for the key you actually want, and fetching the
 * parent means pulling a 12KB blob to read one string.
 *
 * @param  mixed    $value
 * @param  string[] $parts
 * @return array           { found: bool, value: mixed }
 */
function claude_option_walk( $value, $parts ) {
    foreach ( $parts as $part ) {
        if ( is_array( $value ) && array_key_exists( $part, $value ) ) {
            $value = $value[ $part ];
        } elseif ( is_object( $value ) && isset( $value->$part ) ) {
            $value = $value->$part;
        } else {
            return array( 'found' => false, 'value' => null );
        }
    }
    return array( 'found' => true, 'value' => $value );
}

function claude_options_get( $req ) {
    $key = sanitize_text_field( (string) $req->get_param( 'key' ) );
    if ( ! $key ) return new WP_Error( 'missing', 'Provide ?key=option_name (dotted paths supported, e.g. et_divi.divi_integration_head).', array( 'status' => 400 ) );

    // Dotted path: read a single value out of a serialised option.
    if ( false !== strpos( $key, '.' ) ) {
        $parts = explode( '.', $key );
        $root  = array_shift( $parts );

        // The blocklist has to be enforced on the ROOT key, or it is trivially
        // bypassed by asking for "auth_key.anything".
        if ( in_array( $root, claude_blocked_options(), true ) ) {
            return new WP_Error( 'blocked', "Option '{$root}' is protected and cannot be read via API.", array( 'status' => 403 ) );
        }

        $walk = claude_option_walk( get_option( $root ), $parts );

        return new WP_REST_Response( array(
            'key'   => $key,
            'root'  => $root,
            'path'  => $parts,
            'found' => $walk['found'],
            'value' => $walk['value'],
        ) );
    }

    if ( in_array( $key, claude_blocked_options(), true ) ) {
        return new WP_Error( 'blocked', "Option '{$key}' is protected and cannot be read via API.", array( 'status' => 403 ) );
    }
    return new WP_REST_Response( array( 'key' => $key, 'value' => get_option( $key ) ) );
}

function claude_options_set( $req ) {
    $body  = (array) $req->get_json_params();
    $key   = sanitize_text_field( (string) ( $body['key'] ?? '' ) );
    $value = $body['value'] ?? null;
    if ( ! $key ) return new WP_Error( 'missing', 'Body must include "key" (dotted paths supported).', array( 'status' => 400 ) );

    // Dotted path: patch one value inside a serialised option, leaving the rest
    // of the array untouched.
    if ( false !== strpos( $key, '.' ) ) {
        $parts = explode( '.', $key );
        $root  = array_shift( $parts );

        if ( in_array( $root, claude_blocked_options(), true ) ) {
            return new WP_Error( 'blocked', "Option '{$root}' is protected and cannot be modified via API.", array( 'status' => 403 ) );
        }

        $existing = get_option( $root );
        if ( ! is_array( $existing ) ) {
            if ( false !== $existing && null !== $existing ) {
                return new WP_Error(
                    'not_an_array',
                    "Option '{$root}' is not an array, so '{$key}' cannot be patched into it.",
                    array( 'status' => 409 )
                );
            }
            $existing = array();
        }

        // Build a reference down the path, creating intermediate arrays.
        $cursor = &$existing;
        foreach ( $parts as $part ) {
            if ( ! is_array( $cursor ) ) $cursor = array();
            if ( ! array_key_exists( $part, $cursor ) ) $cursor[ $part ] = array();
            $cursor = &$cursor[ $part ];
        }
        $cursor = $value;
        unset( $cursor );

        return new WP_REST_Response( array(
            'key'     => $key,
            'root'    => $root,
            'path'    => $parts,
            'updated' => update_option( $root, $existing ),
        ) );
    }

    if ( in_array( $key, claude_blocked_options(), true ) ) {
        return new WP_Error( 'blocked', "Option '{$key}' is protected and cannot be modified via API.", array( 'status' => 403 ) );
    }
    return new WP_REST_Response( array( 'key' => $key, 'updated' => update_option( $key, $value ) ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Plugins
// ──────────────────────────────────────────────────────────────────────────────

function claude_plugins_list() {
    if ( ! function_exists( 'get_plugins' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $active = get_option( 'active_plugins', array() );
    $result = array();
    foreach ( get_plugins() as $file => $data ) {
        $result[] = array(
            'file'        => $file,
            'name'        => $data['Name'],
            'version'     => $data['Version'],
            'author'      => wp_strip_all_tags( $data['Author'] ),
            'description' => wp_strip_all_tags( $data['Description'] ),
            'active'      => in_array( $file, $active, true ),
        );
    }
    return new WP_REST_Response( $result );
}

function claude_plugins_manage( $req ) {
    if ( ! function_exists( 'activate_plugin' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $plugin = sanitize_text_field( (string) $req->get_param( 'plugin' ) );
    $action = sanitize_text_field( (string) $req->get_param( 'action' ) );
    if ( $action === 'install' ) {
        return claude_maint_install_plugin( $req );
    }
    if ( ! $plugin || ! $action ) {
        return new WP_Error( 'missing', 'Body must include "plugin" and "action".', array( 'status' => 400 ) );
    }
    if ( $action === 'activate' ) {
        $result = claude_maint_activate_checked( $plugin );
        if ( is_wp_error( $result ) ) return $result;
        return new WP_REST_Response( array( 'activated' => $plugin, 'health' => $result['health'] ) );
    }
    if ( $action === 'deactivate' ) {
        if ( $plugin === claude_connector_basename() ) {
            return new WP_Error( 'forbidden', 'Refusing to deactivate Claude Connector through its own API - that would cut off access to this site.', array( 'status' => 403 ) );
        }
        deactivate_plugins( $plugin );
        return new WP_REST_Response( array( 'deactivated' => $plugin ) );
    }
    if ( $action === 'update' ) {
        $req->set_param( 'type', 'plugin' );
        $req->set_param( 'item', $plugin );
        return claude_maint_update( $req );
    }
    if ( $action === 'delete' ) {
        return claude_maint_delete_plugin( $plugin );
    }
    return new WP_Error( 'invalid_action', 'action must be activate, deactivate, install, update or delete.', array( 'status' => 400 ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Themes
// ──────────────────────────────────────────────────────────────────────────────

function claude_themes_list() {
    $active = get_stylesheet();
    $result = array();
    foreach ( wp_get_themes() as $slug => $theme ) {
        $result[] = array(
            'stylesheet' => $slug,
            'name'       => $theme->get( 'Name' ),
            'version'    => $theme->get( 'Version' ),
            'author'     => wp_strip_all_tags( $theme->get( 'Author' ) ),
            'parent'     => $theme->get( 'Template' ),
            'active'     => $slug === $active,
        );
    }
    return new WP_REST_Response( $result );
}

function claude_themes_switch( $req ) {
    $stylesheet = sanitize_text_field( (string) $req->get_param( 'stylesheet' ) );
    if ( ! $stylesheet ) return new WP_Error( 'missing', 'Body must include "stylesheet".', array( 'status' => 400 ) );
    if ( $req->get_param( 'action' ) === 'delete' ) return claude_themes_delete( $stylesheet );
    if ( ! wp_get_theme( $stylesheet )->exists() ) {
        return new WP_Error( 'not_found', "Theme '{$stylesheet}' not found.", array( 'status' => 404 ) );
    }
    switch_theme( $stylesheet );
    return new WP_REST_Response( array( 'active_theme' => get_stylesheet() ) );
}

/**
 * POST /themes { action: "delete", stylesheet } - deletes an installed theme
 * that nothing uses: never the active theme, the parent of the active (child)
 * theme, or - on multisite - a theme any site in the network uses. Says so when
 * no default (Twenty-something) theme would be left as a fallback.
 */
function claude_themes_delete( $stylesheet ) {
    claude_maint_load();
    $theme = wp_get_theme( $stylesheet );
    if ( ! $theme->exists() ) return new WP_Error( 'not_found', "Theme '{$stylesheet}' is not installed.", array( 'status' => 404 ) );
    $name = $theme->get( 'Name' );
    if ( $stylesheet === get_stylesheet() ) {
        return new WP_Error( 'in_use', "{$name} is the active theme - switch to another theme first.", array( 'status' => 409 ) );
    }
    if ( $stylesheet === get_template() ) {
        return new WP_Error( 'in_use', "{$name} is the parent of the active theme (" . wp_get_theme()->get( 'Name' ) . ') - deleting it would break the site.', array( 'status' => 409 ) );
    }
    if ( is_multisite() ) {
        foreach ( get_sites( array( 'number' => 0, 'fields' => 'ids' ) ) as $blog ) {
            if ( in_array( $stylesheet, array( get_blog_option( $blog, 'stylesheet' ), get_blog_option( $blog, 'template' ) ), true ) ) {
                return new WP_Error( 'in_use', "{$name} is used by " . get_home_url( $blog ) . ' in this network.', array( 'status' => 409 ) );
            }
        }
    }
    $fs = claude_maint_filesystem();
    if ( is_wp_error( $fs ) ) return $fs;
    $version = $theme->get( 'Version' );
    ob_start();
    $r = delete_theme( $stylesheet );
    ob_end_clean();
    if ( is_wp_error( $r ) ) return $r;
    if ( ! $r ) return new WP_Error( 'delete_failed', "Could not delete {$name}.", array( 'status' => 500 ) );
    wp_clean_themes_cache();
    $defaults = array_filter( array_keys( wp_get_themes() ), function ( $t ) { return strpos( $t, 'twenty' ) === 0; } );
    return new WP_REST_Response( array(
        'deleted' => $stylesheet,
        'name'    => $name,
        'version' => $version,
        'health'  => claude_loopback_health(),
        'note'    => $defaults ? null : 'No default WordPress theme (Twenty-something) is installed now. WordPress falls back to one if the active theme breaks - consider keeping one.',
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Maintenance  (updates, installs, health, forms - what the dashboard drives)
//
//  Every update is one item per request: back up the installed copy, update it,
//  load the site with the same fatal-error check PHP file writes use, and put
//  the backup back if the site now fatals. The rollback runs inside the same
//  request, which still has the old code in memory - so it works even when the
//  new version would kill every later request, REST included.
// ──────────────────────────────────────────────────────────────────────────────

function claude_maint_load() {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    require_once ABSPATH . 'wp-admin/includes/plugin-install.php'; // plugins_api(); admin.php skips it outside wp-admin
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
}

/**
 * Sets up $wp_filesystem the way the upgrader needs it, or says why it can't.
 *
 * @return true|WP_Error
 */
function claude_maint_filesystem() {
    if ( ! wp_is_file_mod_allowed( 'claude_connector_maintenance' ) ) {
        return new WP_Error( 'file_mods_disabled', 'This site blocks installs and updates (DISALLOW_FILE_MODS in wp-config.php).', array( 'status' => 403 ) );
    }
    ob_start();
    $ok = WP_Filesystem();
    ob_end_clean();
    if ( ! $ok ) {
        return new WP_Error(
            'filesystem_unavailable',
            'WordPress cannot write files directly on this host (method: ' . get_filesystem_method() . ') and no FTP credentials are set in wp-config.php (FTP_HOST / FTP_USER / FTP_PASS).',
            array( 'status' => 500 )
        );
    }
    return true;
}

/**
 * WordPress version branch, "6.8.1" -> "6.8". WordPress calls a change here a major release.
 */
function claude_maint_branch( $version ) {
    return implode( '.', array_slice( explode( '.', (string) $version ), 0, 2 ) );
}

/**
 * The core update to install: the newest offer on the current branch, or the
 * newest of all when major updates are allowed.
 *
 * Reads the raw offers rather than get_core_updates(): that skips "autoupdate"
 * offers, which is how the API sends the latest release on an older branch
 * (6.4.1 -> 6.4.13), so a site on an old branch would never see its minor update.
 *
 * @return object|null
 */
function claude_maint_core_offer( $allow_major ) {
    $current = get_bloginfo( 'version' );
    $from    = get_site_transient( 'update_core' );
    $best    = null;
    foreach ( (array) ( $from->updates ?? array() ) as $offer ) {
        if ( ! isset( $offer->response, $offer->current, $offer->packages ) || ! in_array( $offer->response, array( 'upgrade', 'autoupdate' ), true ) ) continue;
        if ( version_compare( $offer->current, $current, '<=' ) ) continue;
        if ( ! $allow_major && claude_maint_branch( $offer->current ) !== claude_maint_branch( $current ) ) continue;
        $newer = ! $best || version_compare( $offer->current, $best->current, '>' );
        // Same version in the site's own language beats en_US.
        $same_better_locale = $best && $offer->current === $best->current && ( $offer->locale ?? '' ) === get_locale();
        if ( $newer || $same_better_locale ) $best = $offer;
    }
    return $best;
}

function claude_maint_core_info() {
    $current = get_bloginfo( 'version' );
    $minor   = claude_maint_core_offer( false );
    $any     = claude_maint_core_offer( true );
    $shape   = function ( $o ) {
        return $o ? array(
            'version'        => $o->current,
            'php_compatible' => empty( $o->php_version ) || version_compare( PHP_VERSION, $o->php_version, '>=' ),
            'php_required'   => $o->php_version ?? null,
        ) : null;
    };
    return array(
        'version' => $current,
        'minor'   => $shape( $minor ),
        'major'   => ( $any && claude_maint_branch( $any->current ) !== claude_maint_branch( $current ) ) ? $shape( $any ) : null,
    );
}

/**
 * Known SMTP / mail-delivery plugins. Without one, wp_mail() falls back to PHP
 * mail(), which many hosts drop or send straight to spam.
 */
function claude_maint_mailer() {
    $known = array(
        'wp-mail-smtp/wp_mail_smtp.php'                  => 'WP Mail SMTP',
        'wp-mail-smtp-pro/wp_mail_smtp.php'              => 'WP Mail SMTP Pro',
        'fluent-smtp/fluent-smtp.php'                    => 'FluentSMTP',
        'post-smtp/postman-smtp.php'                     => 'Post SMTP',
        'easy-wp-smtp/easy-wp-smtp.php'                  => 'Easy WP SMTP',
        'smtp-mailer/main.php'                           => 'SMTP Mailer',
        'gosmtp/gosmtp.php'                              => 'GoSMTP',
        'suremails/suremails.php'                        => 'SureMail',
        'wp-ses/wp-ses.php'                              => 'WP Offload SES',
        'mailgun/mailgun.php'                            => 'Mailgun',
        'sendgrid-email-delivery-simplified/wpsendgrid.php' => 'SendGrid',
        'mailin/sendinblue.php'                          => 'Brevo',
    );
    foreach ( $known as $file => $name ) {
        if ( is_plugin_active( $file ) ) return array( 'plugin' => $name, 'warning' => null );
    }
    return array(
        'plugin'  => null,
        'warning' => 'No SMTP plugin active - mail goes out through PHP mail(), which many hosts block or send to spam.',
    );
}

function claude_maint_overview( $req ) {
    claude_maint_load();
    if ( rest_sanitize_boolean( $req->get_param( 'refresh' ) ) ) {
        wp_clean_update_cache();
        wp_version_check( array(), true );
        wp_update_plugins();
        wp_update_themes();
    }

    $plugin_updates = get_site_transient( 'update_plugins' );
    $auto_plugins   = (array) get_site_option( 'auto_update_plugins', array() );
    $self           = claude_connector_basename();
    $plugins        = array();
    foreach ( get_plugins() as $file => $data ) {
        $u    = $plugin_updates->response[ $file ] ?? null;
        $seen = $u ?: ( $plugin_updates->no_update[ $file ] ?? null );
        $plugins[] = array(
            'file'        => $file,
            'name'        => $data['Name'],
            'version'     => $data['Version'],
            'author'      => wp_strip_all_tags( $data['Author'] ),
            'active'      => is_plugin_active( $file ),
            'auto_update' => in_array( $file, $auto_plugins, true ),
            'slug'        => $seen->slug ?? ( dirname( $file ) === '.' ? basename( $file, '.php' ) : dirname( $file ) ),
            // wordpress.org plugins can be rolled back to any published version.
            'wporg'       => isset( $seen->id ) && strpos( (string) $seen->id, 'w.org/plugins/' ) === 0,
            'self'        => $file === $self,
            'update'      => $u ? array(
                'version'      => $u->new_version ?? null,
                // No package = a premium plugin whose licence is missing or expired.
                'package'      => ! empty( $u->package ),
                'tested'       => $u->tested ?? null,
                'requires_php' => $u->requires_php ?? null,
                'php_ok'       => empty( $u->requires_php ) || version_compare( PHP_VERSION, $u->requires_php, '>=' ),
            ) : null,
        );
    }

    $theme_updates = get_site_transient( 'update_themes' );
    $themes        = array();
    foreach ( wp_get_themes() as $slug => $theme ) {
        $u        = $theme_updates->response[ $slug ] ?? null;
        $themes[] = array(
            'stylesheet' => $slug,
            'name'       => $theme->get( 'Name' ),
            'version'    => $theme->get( 'Version' ),
            'parent'     => $theme->get( 'Template' ) !== $slug ? $theme->get( 'Template' ) : '',
            'active'     => $slug === get_stylesheet(),
            'in_use'     => $slug === get_stylesheet() || $slug === get_template(),
            'update'     => $u ? array(
                'version' => $u['new_version'] ?? null,
                'package' => ! empty( $u['package'] ),
            ) : null,
        );
    }

    $maintenance_file = ABSPATH . '.maintenance';
    return new WP_REST_Response( array(
        'name'           => get_bloginfo( 'name' ),
        'home_url'       => home_url( '/' ),
        'plugin_version' => CLAUDE_CONNECTOR_VERSION,
        'php_version'    => PHP_VERSION,
        'core'           => claude_maint_core_info(),
        'plugins'        => $plugins,
        'themes'         => $themes,
        'translations'   => count( wp_get_translation_updates() ),
        'mailer'         => claude_maint_mailer(),
        'filesystem'     => array(
            'method'    => get_filesystem_method(),
            'file_mods' => wp_is_file_mod_allowed( 'claude_connector_maintenance' ),
        ),
        // A .maintenance file left behind by an interrupted update shows every
        // visitor "Briefly unavailable for scheduled maintenance" indefinitely.
        'stuck_maintenance' => file_exists( $maintenance_file ) && filemtime( $maintenance_file ) < time() - 10 * MINUTE_IN_SECONDS,
        'last_checked'   => isset( $plugin_updates->last_checked ) ? gmdate( 'c', $plugin_updates->last_checked ) : null,
        'woocommerce'    => claude_wc_templates(),
    ) );
}

function claude_maint_health() {
    $maintenance_file = ABSPATH . '.maintenance';
    return new WP_REST_Response( array_merge(
        claude_loopback_health(),
        array( 'stuck_maintenance' => file_exists( $maintenance_file ) && filemtime( $maintenance_file ) < time() - 10 * MINUTE_IN_SECONDS )
    ) );
}

// ── Backups for rollback ─────────────────────────────────────────────────────

/**
 * Invalidates opcache for a plugin/theme folder or file, so the health check
 * (and a restore) run the bytes on disk rather than cached ones.
 */
function claude_maint_opcache( $path ) {
    if ( is_dir( $path ) ) {
        if ( function_exists( 'wp_opcache_invalidate_directory' ) ) {
            wp_opcache_invalidate_directory( $path );
            return;
        }
        $it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ) );
        foreach ( $it as $f ) {
            if ( substr( $f->getFilename(), -4 ) === '.php' ) wp_opcache_invalidate( $f->getPathname(), true );
        }
    } elseif ( is_file( $path ) ) {
        wp_opcache_invalidate( $path, true );
    }
}

/**
 * Copies a plugin/theme (folder or single file) to wp-content/claude-rollback
 * before it is updated. Kept only for the length of the request.
 *
 * Not wp-content/upgrade: WP_Upgrader::unpack_package() empties that folder
 * before every unpack, which would delete the backup mid-update.
 *
 * @return array|WP_Error { src, copy, root }
 */
function claude_maint_backup( $src ) {
    global $wp_filesystem;
    $base = WP_CONTENT_DIR . '/claude-rollback';
    if ( ! wp_mkdir_p( $base ) ) {
        return new WP_Error( 'backup_failed', "Could not create {$base} to back up before updating - update not attempted.", array( 'status' => 500 ) );
    }
    // The copy holds runnable PHP for a few seconds; keep it unreachable on Apache.
    if ( ! file_exists( $base . '/.htaccess' ) ) {
        $wp_filesystem->put_contents( $base . '/.htaccess', "Require all denied\nDeny from all\n" );
        $wp_filesystem->put_contents( $base . '/index.php', "<?php\n// Silence is golden.\n" );
    }
    // Clear out copies left by a request that died part-way.
    foreach ( (array) glob( $base . '/*', GLOB_ONLYDIR ) as $old ) {
        if ( $old && filemtime( $old ) < time() - DAY_IN_SECONDS ) $wp_filesystem->delete( $old, true );
    }

    $root = $base . '/' . gmdate( 'Ymd-His' ) . '-' . strtolower( wp_generate_password( 6, false, false ) );
    if ( ! wp_mkdir_p( $root ) ) {
        return new WP_Error( 'backup_failed', "Could not create {$root} to back up before updating - update not attempted.", array( 'status' => 500 ) );
    }

    $copy = $root . '/' . basename( $src );
    if ( is_dir( $src ) ) {
        wp_mkdir_p( $copy );
        $ok = copy_dir( $src, $copy );
    } else {
        $ok = $wp_filesystem->copy( $src, $copy, true );
    }
    if ( ! $ok || is_wp_error( $ok ) ) {
        $wp_filesystem->delete( $root, true );
        $why = is_wp_error( $ok ) ? ': ' . $ok->get_error_message() : '';
        return new WP_Error( 'backup_failed', 'Could not back up ' . basename( $src ) . " before updating{$why} - update not attempted.", array( 'status' => 500 ) );
    }
    return array( 'src' => $src, 'copy' => $copy, 'root' => $root );
}

function claude_maint_backup_drop( $backup ) {
    global $wp_filesystem;
    $wp_filesystem->delete( $backup['root'], true );
}

/**
 * Puts a backup back in place of whatever is installed now.
 */
function claude_maint_restore( $backup ) {
    global $wp_filesystem;
    if ( file_exists( $backup['src'] ) ) $wp_filesystem->delete( $backup['src'], true );
    $ok = $wp_filesystem->move( $backup['copy'], $backup['src'], true );
    if ( ! $ok ) {
        // Rename can fail across mounts; fall back to copying.
        if ( is_dir( $backup['copy'] ) ) {
            wp_mkdir_p( $backup['src'] );
            $ok = copy_dir( $backup['copy'], $backup['src'] ) === true;
        } else {
            $ok = $wp_filesystem->copy( $backup['copy'], $backup['src'], true );
        }
    }
    claude_maint_opcache( $backup['src'] );
    if ( $ok ) claude_maint_backup_drop( $backup );
    return (bool) $ok;
}

/**
 * After a failed update or install: core restores its own temp backup since
 * 6.3, but older versions may already have deleted the old copy - put ours back
 * if so, otherwise just discard it.
 *
 * @return bool  Whether the previous version is in place.
 */
function claude_maint_settle_failed( $backup ) {
    if ( ! file_exists( $backup['src'] ) ) return claude_maint_restore( $backup );
    claude_maint_backup_drop( $backup );
    return true;
}

/**
 * Runs one upgrader call with output captured, so a skin or a plugin's
 * upgrade hook echoing HTML cannot corrupt the JSON response.
 *
 * @return array { result, messages }
 */
function claude_maint_run_upgrader( callable $fn, $skin ) {
    ob_start();
    try {
        $result = $fn();
    } finally {
        $stray = trim( wp_strip_all_tags( (string) ob_get_clean() ) );
    }
    $messages = array();
    foreach ( (array) $skin->get_upgrade_messages() as $m ) {
        $m = trim( html_entity_decode( wp_strip_all_tags( (string) $m ), ENT_QUOTES, 'UTF-8' ) );
        if ( $m !== '' ) $messages[] = $m;
    }
    if ( $stray !== '' ) $messages[] = $stray;
    if ( ( $result === null || $result === false ) && is_wp_error( $skin->result ) ) $result = $skin->result;
    return array( 'result' => $result, 'messages' => $messages );
}

/**
 * Health-checks after an update and rolls back on a fatal. Shared by plugin and
 * theme updates, and by installs that overwrite an existing copy.
 *
 * @return array|WP_Error  Response fields on success, WP_Error after a rollback.
 */
function claude_maint_verify( $backup, $label, $from, $to, $check, $extra_urls = array() ) {
    claude_maint_opcache( $backup['src'] );
    $health = $check ? claude_loopback_health( $extra_urls ) : array( 'status' => 'skipped', 'message' => 'Not active, so it cannot affect the site.' );
    if ( $health['status'] !== 'fatal' ) {
        claude_maint_backup_drop( $backup );
        return array( 'health' => $health );
    }

    if ( ! claude_maint_restore( $backup ) ) {
        return new WP_Error(
            'rollback_failed',
            "{$label} {$to} broke the site ({$health['message']}) and restoring {$from} FAILED. The previous copy is in " . $backup['root'] . ' - move it back by FTP / file manager.',
            array( 'status' => 500, 'health' => $health )
        );
    }
    return new WP_Error(
        'update_rolled_back',
        "{$label} {$to} broke the site, so {$from} was put back. Error: {$health['message']}",
        array( 'status' => 422, 'health' => $health, 'after_rollback' => claude_loopback_health(), 'from' => $from, 'to' => $to )
    );
}

// ── WooCommerce stores ───────────────────────────────────────────────────────

/**
 * The store's own pages - shop, cart, checkout, account and one product -
 * loaded after updates that can break a WooCommerce store (WooCommerce, its
 * add-ons, the active theme), so a fatal there is rolled back like one on the
 * homepage. Empty when WooCommerce is not active.
 */
function claude_wc_check_urls() {
    if ( ! function_exists( 'wc_get_page_id' ) ) return array();
    $urls = array();
    foreach ( array( 'shop', 'cart', 'checkout', 'myaccount' ) as $page ) {
        $id = wc_get_page_id( $page );
        if ( $id > 0 && get_post_status( $id ) === 'publish' ) $urls[] = get_permalink( $id );
    }
    $product = get_posts( array( 'post_type' => 'product', 'post_status' => 'publish', 'numberposts' => 1, 'fields' => 'ids', 'orderby' => 'modified' ) );
    if ( $product ) $urls[] = get_permalink( $product[0] );
    return array_values( array_unique( array_filter( $urls ) ) );
}

/** WooCommerce itself, or a plugin built on it (an add-on or extension). */
function claude_wc_related_plugin( $file ) {
    if ( ! class_exists( 'WooCommerce' ) ) return false;
    if ( preg_match( '/woo|wc[-_]/i', dirname( $file ) ) ) return true;
    $h = get_file_data( WP_PLUGIN_DIR . '/' . $file, array( 'wc' => 'WC requires at least', 'needs' => 'Requires Plugins' ) );
    return $h['wc'] !== '' || stripos( (string) $h['needs'], 'woocommerce' ) !== false;
}

/**
 * The theme's copies of WooCommerce templates, and which are older than the
 * installed WooCommerce's - the same comparison as WooCommerce > Status. A
 * WooCommerce update can make more of them outdated, and an outdated
 * template is a common cause of a broken shop or checkout.
 */
function claude_wc_templates() {
    if ( ! class_exists( 'WooCommerce' ) || ! defined( 'WC_ABSPATH' ) ) return null;
    if ( ! class_exists( 'WC_Admin_Status' ) ) include_once WC_ABSPATH . 'includes/admin/class-wc-admin-status.php';
    if ( ! class_exists( 'WC_Admin_Status' ) ) return null;
    $core  = WC()->plugin_path() . '/templates/';
    $dirs  = array_unique( array( get_stylesheet_directory(), get_template_directory() ) );
    $files = array();
    foreach ( WC_Admin_Status::scan_template_files( $core ) as $file ) {
        foreach ( $dirs as $dir ) {
            foreach ( array( $dir . '/' . WC()->template_path() . $file, $dir . '/' . $file ) as $theme_file ) {
                if ( ! file_exists( $theme_file ) ) continue;
                $core_v  = WC_Admin_Status::get_file_version( $core . $file );
                $theme_v = WC_Admin_Status::get_file_version( $theme_file );
                $files[] = array(
                    'file'     => str_replace( wp_normalize_path( get_theme_root() ) . '/', '', wp_normalize_path( $theme_file ) ),
                    'version'  => $theme_v ?: null,
                    'core'     => $core_v ?: null,
                    'outdated' => $core_v && ( ! $theme_v || version_compare( $theme_v, $core_v, '<' ) ),
                );
                continue 3;
            }
        }
    }
    $outdated = array_values( array_filter( $files, function ( $f ) { return $f['outdated']; } ) );
    return array(
        'version'   => WC()->version,
        'overrides' => count( $files ),
        'outdated'  => count( $outdated ),
        'files'     => array_slice( array_merge( $outdated, array_filter( $files, function ( $f ) { return ! $f['outdated']; } ) ), 0, 100 ),
    );
}

// ── Updates ──────────────────────────────────────────────────────────────────

function claude_maint_update_plugin( $file ) {
    $installed = get_plugins();
    if ( ! isset( $installed[ $file ] ) ) {
        return new WP_Error( 'not_found', "Plugin '{$file}' is not installed.", array( 'status' => 404 ) );
    }
    wp_update_plugins();
    $current = get_site_transient( 'update_plugins' );
    $offer   = $current->response[ $file ] ?? null;
    $from    = $installed[ $file ]['Version'];
    $name    = $installed[ $file ]['Name'];
    if ( ! $offer ) {
        return array( 'status' => 'up_to_date', 'item' => $file, 'name' => $name, 'version' => $from );
    }
    if ( empty( $offer->package ) ) {
        return new WP_Error( 'no_package', "{$name} {$offer->new_version} is available but has no download - usually a missing or expired licence key. Update it from the vendor's dashboard.", array( 'status' => 422 ) );
    }

    $was_active = is_plugin_active( $file );
    $src        = WP_PLUGIN_DIR . '/' . ( dirname( $file ) === '.' ? $file : dirname( $file ) );
    $backup     = claude_maint_backup( $src );
    if ( is_wp_error( $backup ) ) return $backup;

    // Plugin_Upgrader silently deactivates an active plugin before updating it,
    // and wp-admin turns it back on from an iframe that a REST call never loads.
    // Background (cron) updates skip the deactivation - run as one.
    add_filter( 'wp_doing_cron', '__return_true' );
    $skin = new Automatic_Upgrader_Skin();
    $run  = claude_maint_run_upgrader( function () use ( $skin, $file ) {
        return ( new Plugin_Upgrader( $skin ) )->upgrade( $file );
    }, $skin );
    remove_filter( 'wp_doing_cron', '__return_true' );

    if ( ! $run['result'] || is_wp_error( $run['result'] ) ) {
        $restored = claude_maint_settle_failed( $backup );
        $why      = is_wp_error( $run['result'] ) ? $run['result']->get_error_message() : 'the upgrader gave no reason';
        return new WP_Error( 'update_failed', "{$name} could not be updated: {$why}", array( 'status' => 500, 'messages' => $run['messages'], 'previous_restored' => $restored ) );
    }

    wp_clean_plugins_cache( false );
    $data = get_plugin_data( WP_PLUGIN_DIR . '/' . $file, false, false );
    $to   = $data['Version'] ?: $offer->new_version;
    if ( $was_active && ! is_plugin_active( $file ) ) {
        // Re-add without running the plugin's code in this request.
        $active   = (array) get_option( 'active_plugins', array() );
        $active[] = $file;
        update_option( 'active_plugins', array_values( array_unique( $active ) ) );
    }

    $shop     = $was_active && claude_wc_related_plugin( $file ) ? claude_wc_check_urls() : array();
    $verified = claude_maint_verify( $backup, $name, $from, $to, $was_active, $shop );
    if ( is_wp_error( $verified ) ) return $verified;
    return array_merge( array( 'status' => 'updated', 'item' => $file, 'name' => $name, 'from' => $from, 'to' => $to, 'messages' => $run['messages'], 'shop_checked' => count( $shop ) ), $verified );
}

function claude_maint_update_theme( $stylesheet ) {
    $theme = wp_get_theme( $stylesheet );
    if ( ! $theme->exists() ) {
        return new WP_Error( 'not_found', "Theme '{$stylesheet}' is not installed.", array( 'status' => 404 ) );
    }
    wp_update_themes();
    $current = get_site_transient( 'update_themes' );
    $offer   = $current->response[ $stylesheet ] ?? null;
    $from    = $theme->get( 'Version' );
    $name    = $theme->get( 'Name' );
    if ( ! $offer ) {
        return array( 'status' => 'up_to_date', 'item' => $stylesheet, 'name' => $name, 'version' => $from );
    }
    if ( empty( $offer['package'] ) ) {
        return new WP_Error( 'no_package', "{$name} {$offer['new_version']} is available but has no download - usually a missing or expired licence key.", array( 'status' => 422 ) );
    }

    $backup = claude_maint_backup( $theme->get_stylesheet_directory() );
    if ( is_wp_error( $backup ) ) return $backup;

    $skin = new Automatic_Upgrader_Skin();
    $run  = claude_maint_run_upgrader( function () use ( $skin, $stylesheet ) {
        return ( new Theme_Upgrader( $skin ) )->upgrade( $stylesheet );
    }, $skin );

    if ( ! $run['result'] || is_wp_error( $run['result'] ) ) {
        $restored = claude_maint_settle_failed( $backup );
        $why      = is_wp_error( $run['result'] ) ? $run['result']->get_error_message() : 'the upgrader gave no reason';
        return new WP_Error( 'update_failed', "{$name} could not be updated: {$why}", array( 'status' => 500, 'messages' => $run['messages'], 'previous_restored' => $restored ) );
    }

    wp_clean_themes_cache();
    $to       = wp_get_theme( $stylesheet )->get( 'Version' ) ?: $offer['new_version'];
    $in_use   = $stylesheet === get_stylesheet() || $stylesheet === get_template();
    $shop     = $in_use ? claude_wc_check_urls() : array(); // the theme may override WooCommerce's templates
    $verified = claude_maint_verify( $backup, $name, $from, $to, $in_use, $shop );
    if ( is_wp_error( $verified ) ) return $verified;
    return array_merge( array( 'status' => 'updated', 'item' => $stylesheet, 'name' => $name, 'from' => $from, 'to' => $to, 'messages' => $run['messages'], 'shop_checked' => count( $shop ) ), $verified );
}

function claude_maint_update_core( $allow_major ) {
    $from  = get_bloginfo( 'version' );
    $offer = claude_maint_core_offer( $allow_major );
    if ( ! $offer ) {
        $major = claude_maint_core_offer( true );
        return array(
            'status'  => 'up_to_date',
            'item'    => 'core',
            'version' => $from,
            'note'    => $major ? "WordPress {$major->current} is available - a major update, skipped unless allow_major is set." : null,
        );
    }
    if ( ! empty( $offer->php_version ) && version_compare( PHP_VERSION, $offer->php_version, '<' ) ) {
        return new WP_Error( 'php_too_old', "WordPress {$offer->current} needs PHP {$offer->php_version}; this site runs " . PHP_VERSION . '.', array( 'status' => 422 ) );
    }

    $skin = new Automatic_Upgrader_Skin();
    // update_core() reports progress through this filter and would echo it otherwise.
    add_filter( 'update_feedback', array( $skin, 'feedback' ) );
    $run = claude_maint_run_upgrader( function () use ( $skin, $offer ) {
        return ( new Core_Upgrader( $skin ) )->upgrade( $offer );
    }, $skin );
    remove_filter( 'update_feedback', array( $skin, 'feedback' ) );

    if ( ! $run['result'] || is_wp_error( $run['result'] ) ) {
        $why = is_wp_error( $run['result'] ) ? $run['result']->get_error_message() : 'the upgrader gave no reason';
        return new WP_Error( 'update_failed', "WordPress could not be updated to {$offer->current}: {$why}", array( 'status' => 500, 'messages' => $run['messages'] ) );
    }
    // No automatic rollback for core: half-restoring core is worse than a fatal
    // the health check reports.
    return array(
        'status'   => 'updated',
        'item'     => 'core',
        'name'     => 'WordPress',
        'from'     => $from,
        'to'       => is_string( $run['result'] ) ? $run['result'] : $offer->current,
        'messages' => $run['messages'],
        'health'   => claude_loopback_health(),
    );
}

function claude_maint_update_translations() {
    $updates = wp_get_translation_updates();
    if ( ! $updates ) {
        return array( 'status' => 'up_to_date', 'item' => 'translations' );
    }
    $skin = new Automatic_Upgrader_Skin();
    $run  = claude_maint_run_upgrader( function () use ( $skin, $updates ) {
        return ( new Language_Pack_Upgrader( $skin ) )->bulk_upgrade( $updates );
    }, $skin );
    if ( is_wp_error( $run['result'] ) ) {
        return new WP_Error( 'update_failed', 'Translations could not be updated: ' . $run['result']->get_error_message(), array( 'status' => 500 ) );
    }
    $done = is_array( $run['result'] ) ? count( array_filter( $run['result'], function ( $r ) { return $r && ! is_wp_error( $r ); } ) ) : 0;
    return array( 'status' => 'updated', 'item' => 'translations', 'name' => 'Translations', 'count' => $done, 'of' => count( $updates ), 'messages' => $run['messages'] );
}

/**
 * POST /maintenance/update { type: plugin|theme|core|translations, item?, allow_major? }
 */
function claude_maint_update( $req ) {
    claude_maint_load();
    $fs = claude_maint_filesystem();
    if ( is_wp_error( $fs ) ) return $fs;
    @set_time_limit( 300 ); // phpcs:ignore

    $type = sanitize_key( (string) $req->get_param( 'type' ) );
    $item = sanitize_text_field( (string) $req->get_param( 'item' ) );
    if ( in_array( $type, array( 'plugin', 'theme' ), true ) && $item === '' ) {
        return new WP_Error( 'missing', "type \"{$type}\" needs \"item\" (plugin file or theme stylesheet).", array( 'status' => 400 ) );
    }
    switch ( $type ) {
        case 'plugin':       $r = claude_maint_update_plugin( $item ); break;
        case 'theme':        $r = claude_maint_update_theme( $item ); break;
        case 'core':         $r = claude_maint_update_core( rest_sanitize_boolean( $req->get_param( 'allow_major' ) ) ); break;
        case 'translations': $r = claude_maint_update_translations(); break;
        default:
            return new WP_Error( 'invalid_type', 'type must be plugin, theme, core or translations.', array( 'status' => 400 ) );
    }
    if ( is_wp_error( $r ) ) return $r;
    return new WP_REST_Response( array_merge( array( 'type' => $type ), $r ) );
}

// ── Installs ─────────────────────────────────────────────────────────────────

/**
 * Installs a plugin from wordpress.org (slug, optionally a specific version)
 * or a zip URL. With overwrite, replaces the installed copy - which is also how
 * a wordpress.org plugin is rolled back to an older version.
 */
function claude_maint_install_plugin( $req ) {
    claude_maint_load();
    $fs = claude_maint_filesystem();
    if ( is_wp_error( $fs ) ) return $fs;
    @set_time_limit( 300 ); // phpcs:ignore

    $slug      = sanitize_key( (string) $req->get_param( 'slug' ) );
    $url       = esc_url_raw( (string) $req->get_param( 'url' ) );
    $version   = sanitize_text_field( (string) $req->get_param( 'version' ) );
    $activate  = rest_sanitize_boolean( $req->get_param( 'activate' ) );
    $overwrite = rest_sanitize_boolean( $req->get_param( 'overwrite' ) );

    if ( $slug ) {
        $api = plugins_api( 'plugin_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false, 'versions' => $version !== '' ) ) );
        if ( is_wp_error( $api ) ) {
            return new WP_Error( 'not_found', "No plugin '{$slug}' on wordpress.org: " . $api->get_error_message(), array( 'status' => 404 ) );
        }
        if ( $version !== '' && empty( $api->versions[ $version ] ) ) {
            return new WP_Error( 'no_such_version', "{$api->name} has no version {$version} on wordpress.org.", array( 'status' => 404 ) );
        }
        $package = $version !== '' ? $api->versions[ $version ] : $api->download_link;
    } elseif ( $url ) {
        $package = $url;
    } else {
        return new WP_Error( 'missing', 'install needs "slug" (wordpress.org) or "url" (a plugin zip).', array( 'status' => 400 ) );
    }

    // Already installed? Find it by folder.
    $existing = null;
    if ( $slug ) {
        foreach ( array_keys( get_plugins() ) as $file ) {
            if ( dirname( $file ) === $slug ) { $existing = $file; break; }
        }
    }
    if ( $existing && ! $overwrite ) {
        return new WP_Error( 'already_installed', "{$slug} is already installed ({$existing}). Pass overwrite to replace it, e.g. to roll back to a version.", array( 'status' => 409, 'file' => $existing ) );
    }

    $backup     = null;
    $from       = null;
    $was_active = false;
    if ( $existing ) {
        $from       = get_plugins()[ $existing ]['Version'];
        $was_active = is_plugin_active( $existing );
        $backup     = claude_maint_backup( WP_PLUGIN_DIR . '/' . dirname( $existing ) );
        if ( is_wp_error( $backup ) ) return $backup;
    }

    $skin = new Automatic_Upgrader_Skin();
    $up   = null;
    $run  = claude_maint_run_upgrader( function () use ( $skin, $package, $overwrite, &$up ) {
        $up = new Plugin_Upgrader( $skin );
        return $up->install( $package, array( 'overwrite_package' => $overwrite ) );
    }, $skin );
    if ( ! $run['result'] || is_wp_error( $run['result'] ) ) {
        if ( $backup ) claude_maint_settle_failed( $backup );
        $why = is_wp_error( $run['result'] ) ? $run['result']->get_error_message() : 'the upgrader gave no reason';
        return new WP_Error( 'install_failed', "Install failed: {$why}", array( 'status' => 500, 'messages' => $run['messages'] ) );
    }

    wp_clean_plugins_cache( false );
    $file = $up->plugin_info();
    if ( ! $file ) {
        if ( $backup ) claude_maint_backup_drop( $backup );
        return new WP_Error( 'install_failed', 'The package installed but contains no plugin file WordPress recognises.', array( 'status' => 500, 'messages' => $run['messages'] ) );
    }
    $data   = get_plugin_data( WP_PLUGIN_DIR . '/' . $file, false, false );
    $result = array( 'status' => 'installed', 'file' => $file, 'name' => $data['Name'], 'version' => $data['Version'], 'messages' => $run['messages'] );

    if ( $backup ) {
        $verified = claude_maint_verify( $backup, $data['Name'], $from, $data['Version'], $was_active, $was_active && claude_wc_related_plugin( $file ) ? claude_wc_check_urls() : array() );
        if ( is_wp_error( $verified ) ) return $verified;
        $result = array_merge( $result, array( 'status' => 'replaced', 'from' => $from ), $verified );
    }

    if ( $activate && ! is_plugin_active( $file ) ) {
        $activated = claude_maint_activate_checked( $file );
        if ( is_wp_error( $activated ) ) return $activated;
        $result = array_merge( $result, array( 'active' => true, 'health' => $activated['health'] ) );
    }
    return new WP_REST_Response( $result );
}

/**
 * Activates a plugin only if the site still loads with it.
 *
 * activate_plugin() includes the plugin in this request, so a plugin that
 * fatals on load would kill the response before anything could be reported.
 * Load it in a separate request first by listing it as active for the length
 * of one health check, and only then activate it properly (which also runs its
 * activation hook).
 *
 * @return array|WP_Error
 */
function claude_maint_activate_checked( $file ) {
    if ( is_plugin_active( $file ) ) return array( 'health' => array( 'status' => 'skipped', 'message' => 'Already active.' ) );
    $validate = validate_plugin( $file );
    if ( is_wp_error( $validate ) ) return $validate;

    $active = (array) get_option( 'active_plugins', array() );
    update_option( 'active_plugins', array_values( array_unique( array_merge( $active, array( $file ) ) ) ) );
    $trial = claude_loopback_health();
    update_option( 'active_plugins', $active );
    if ( $trial['status'] === 'fatal' ) {
        return new WP_Error(
            'activation_blocked',
            "Not activated: the site fails with {$file} loaded. Error: {$trial['message']}",
            array( 'status' => 422, 'health' => $trial )
        );
    }

    ob_start();
    $r = activate_plugin( $file );
    ob_end_clean();
    if ( is_wp_error( $r ) ) return $r;
    $health = claude_loopback_health();
    if ( $health['status'] === 'fatal' ) {
        deactivate_plugins( $file, true );
        return new WP_Error(
            'activation_rolled_back',
            "Activating {$file} broke the site, so it was deactivated again. Error: {$health['message']}",
            array( 'status' => 422, 'health' => $health )
        );
    }
    return array( 'health' => $health );
}

function claude_maint_delete_plugin( $file ) {
    claude_maint_load();
    if ( $file === claude_connector_basename() ) {
        return new WP_Error( 'forbidden', 'Refusing to delete Claude Connector through its own API - that would cut off access to this site.', array( 'status' => 403 ) );
    }
    if ( ! isset( get_plugins()[ $file ] ) ) {
        return new WP_Error( 'not_found', "Plugin '{$file}' is not installed.", array( 'status' => 404 ) );
    }
    $fs = claude_maint_filesystem();
    if ( is_wp_error( $fs ) ) return $fs;
    if ( is_plugin_active( $file ) ) deactivate_plugins( $file );
    ob_start();
    $r = delete_plugins( array( $file ) );
    ob_end_clean();
    if ( is_wp_error( $r ) ) return $r;
    if ( ! $r ) return new WP_Error( 'delete_failed', "Could not delete {$file}.", array( 'status' => 500 ) );
    return new WP_REST_Response( array( 'deleted' => $file ) );
}

// ── Forms & email ────────────────────────────────────────────────────────────

/**
 * Finds published pages that carry a contact form, so the dashboard knows
 * where to send its test submission. Pages with "contact" in the slug or title
 * come first.
 */
function claude_maint_find_forms() {
    global $wpdb;
    $markers = array(
        'divi'          => array( '[et_pb_contact_form', '<!-- wp:divi/contact-form' ),
        'contact-form-7'=> array( '[contact-form-7', '<!-- wp:contact-form-7/' ),
        'gravity-forms' => array( '[gravityform', '<!-- wp:gravityforms/' ),
        'wpforms'       => array( '[wpforms', '<!-- wp:wpforms/' ),
        'fluent-forms'  => array( '[fluentform', '<!-- wp:fluentfom/' ),
        'forminator'    => array( '[forminator_form', '<!-- wp:forminator/' ),
        'ninja-forms'   => array( '[ninja_form', '<!-- wp:ninja-forms/' ),
    );
    $types = array_values( array_diff( get_post_types( array( 'public' => true ) ), array( 'attachment' ) ) );
    // Divi Theme Builder layouts: a form in a global footer shows on every page.
    $layouts = array( 'et_header_layout', 'et_body_layout', 'et_footer_layout' );

    $likes = array();
    foreach ( $markers as $list ) {
        foreach ( $list as $m ) $likes[] = $wpdb->prepare( 'post_content LIKE %s', '%' . $wpdb->esc_like( $m ) . '%' );
    }
    $in   = implode( ',', array_map( function ( $t ) use ( $wpdb ) { return $wpdb->prepare( '%s', $t ); }, array_merge( $types, $layouts ) ) );
    $rows = $wpdb->get_results( "SELECT ID, post_title, post_name, post_type, post_content FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type IN ({$in}) AND (" . implode( ' OR ', $likes ) . ') ORDER BY post_date DESC LIMIT 50' ); // phpcs:ignore

    $found = array();
    foreach ( $rows as $row ) {
        $plugins = array();
        foreach ( $markers as $plugin => $list ) {
            foreach ( $list as $m ) {
                if ( strpos( $row->post_content, $m ) !== false ) { $plugins[] = $plugin; break; }
            }
        }
        $layout  = in_array( $row->post_type, $layouts, true );
        $found[] = array(
            'post_id' => (int) $row->ID,
            'title'   => $row->post_title,
            'url'     => $layout ? home_url( '/' ) : get_permalink( $row->ID ),
            'via'     => $layout ? 'divi-theme-builder' : 'content',
            'plugins' => $plugins,
            'contact' => (bool) preg_match( '/contact|enquir|inquir|get-in-touch|quote/i', $row->post_name . ' ' . $row->post_title ),
        );
    }

    // Elementor Pro form widgets live in postmeta, not post_content.
    if ( defined( 'ELEMENTOR_VERSION' ) ) {
        $rows = $wpdb->get_results( $wpdb->prepare(
            "SELECT p.ID, p.post_title, p.post_name, p.post_type FROM {$wpdb->posts} p JOIN {$wpdb->postmeta} m ON m.post_id = p.ID
             WHERE m.meta_key = '_elementor_data' AND m.meta_value LIKE %s AND p.post_status = 'publish' LIMIT 30",
            '%' . $wpdb->esc_like( '"widgetType":"form"' ) . '%'
        ) );
        foreach ( $rows as $row ) {
            $template = $row->post_type === 'elementor_library';
            $found[]  = array(
                'post_id' => (int) $row->ID,
                'title'   => $row->post_title,
                'url'     => $template ? home_url( '/' ) : get_permalink( $row->ID ),
                'via'     => $template ? 'elementor-template' : 'content',
                'plugins' => array( 'elementor-pro' ),
                'contact' => (bool) preg_match( '/contact|enquir|inquir|get-in-touch|quote/i', $row->post_name . ' ' . $row->post_title ),
            );
        }
    }

    usort( $found, function ( $a, $b ) {
        if ( $a['contact'] !== $b['contact'] ) return $a['contact'] ? -1 : 1;
        if ( ( $a['via'] === 'content' ) !== ( $b['via'] === 'content' ) ) return $a['via'] === 'content' ? -1 : 1;
        return 0;
    } );
    return $found;
}

function claude_maint_forms() {
    if ( ! function_exists( 'is_plugin_active' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
    return new WP_REST_Response( array( 'forms' => claude_maint_find_forms(), 'mailer' => claude_maint_mailer() ) );
}

/**
 * Plain wp_mail() check - for sites with no form, or to tell a broken form
 * apart from broken mail delivery.
 */
function claude_maint_test_email( $req ) {
    if ( ! function_exists( 'is_plugin_active' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $to  = sanitize_email( (string) $req->get_param( 'to' ) ) ?: get_option( 'admin_email' );
    $ref = sanitize_text_field( (string) $req->get_param( 'ref' ) ) ?: strtoupper( wp_generate_password( 8, false, false ) );

    $error = null;
    $catch = function ( $e ) use ( &$error ) { $error = $e->get_error_message(); };
    add_action( 'wp_mail_failed', $catch );
    $sent = wp_mail(
        $to,
        sprintf( '[%s] Maintenance email test %s', wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ), $ref ),
        "This is an automated maintenance check that this site can send email.\n\nSite: " . home_url( '/' ) . "\nReference: {$ref}\nSent: " . wp_date( 'Y-m-d H:i:s T' ) . "\n"
    );
    remove_action( 'wp_mail_failed', $catch );

    return new WP_REST_Response( array( 'sent' => (bool) $sent, 'to' => $to, 'ref' => $ref, 'error' => $error, 'mailer' => claude_maint_mailer() ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Security check  (read-only - reports, never changes anything)
//
//  Looks for the usual signs of a compromised site: WordPress core and
//  wordpress.org plugin files that differ from their published checksums,
//  files that do not belong in core, PHP in uploads, known malware patterns,
//  active plugins whose files have gone, new administrators, redirects in
//  .htaccess and scripts injected into content. Findings are leads for a
//  person (or Claude) to look into - not proof, and nothing is cleaned here.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Where quarantined files are kept: a hidden, request-blocked folder inside
 * uploads (always writable by WordPress). A moved file keeps its original path
 * so it can be put back.
 */
function claude_security_quarantine_dir() {
    $dir = wp_upload_dir()['basedir'] . '/.claude-quarantine';
    if ( ! is_dir( $dir ) ) {
        wp_mkdir_p( $dir );
        @file_put_contents( $dir . '/.htaccess', "Require all denied\nDeny from all\n" ); // phpcs:ignore
        @file_put_contents( $dir . '/index.php', "<?php // Silence is golden.\n" ); // phpcs:ignore
    }
    return $dir;
}

function claude_security_manifest() {
    $file = claude_security_quarantine_dir() . '/manifest.json';
    $data = is_readable( $file ) ? json_decode( (string) file_get_contents( $file ), true ) : array();
    return array( $file, is_array( $data ) ? $data : array() );
}

/**
 * Whether a path may be quarantined, and why not if it may not. The guard for
 * the whole feature - keep it strict.
 *
 * Allowed: a file inside the WordPress install that is NOT a legitimate core
 * file (its path is absent from wordpress.org's checksums, so it was added),
 * is not wp-config.php, and is not already in quarantine.
 *
 * Refused: anything outside ABSPATH, any file matching the official checksums
 * (that is real core - restore it by reinstalling core, never delete), config
 * files, and directories.
 *
 * @return array|true  array( code, message ) on refusal, true when allowed.
 */
function claude_security_quarantine_allowed( $abs, $sums ) {
    $real = realpath( $abs );
    if ( $real === false || ! is_file( $real ) ) {
        return array( 'not_found', 'No such file.' );
    }
    $base = realpath( ABSPATH );
    $real = wp_normalize_path( $real );
    if ( $base === false || strpos( $real, wp_normalize_path( $base ) . '/' ) !== 0 ) {
        return array( 'outside_site', 'Only files inside this WordPress installation can be quarantined.' );
    }
    $rel = ltrim( substr( $real, strlen( wp_normalize_path( $base ) ) ), '/' );

    $name = strtolower( basename( $rel ) );
    if ( in_array( $name, array( 'wp-config.php', 'wp-config-sample.php', '.user.ini', 'php.ini' ), true ) ) {
        return array( 'protected', basename( $rel ) . ' is a configuration file - review it by hand, it is not removed automatically.' );
    }
    if ( $name === '.htaccess' ) {
        // A .htaccess with rules, or the site-root / wp-content one, is never touched.
        // An EMPTY stub left in wp-admin or wp-includes is just clutter and safe to clear.
        $in_core_dir = preg_match( '#^wp-(admin|includes)/#', $rel );
        $empty       = trim( (string) @file_get_contents( $real ) ) === ''; // phpcs:ignore
        if ( ! $in_core_dir || ! $empty ) {
            return array( 'protected', $rel . ' is an .htaccess file - ' . ( $in_core_dir ? 'it has rules in it, so' : 'only empty ones in wp-admin / wp-includes can be cleared;' ) . ' review it by hand.' );
        }
    }
    if ( is_array( $sums ) && isset( $sums[ $rel ] ) ) {
        return array( 'is_core', "{$rel} is a genuine WordPress core file. If it was modified, restore it with POST /security/reinstall-core (MCP wp_reinstall_core) - do not delete it." );
    }
    if ( $real === claude_security_prepend_file() ) {
        $what = claude_security_wordfence_waf( $real ) === true ? "It is Wordfence's firewall loader - turn off the firewall's Extended Protection in Wordfence > Firewall first if you want it gone." : 'Remove the auto_prepend_file line that points to it (usually in .user.ini or php.ini in the site root - the host can do this) first, then quarantine it.';
        return array( 'protected', "{$rel} is loaded by PHP before every request (auto_prepend_file). Removing it now would take the whole site down. {$what}" );
    }
    if ( strpos( $real, wp_normalize_path( claude_security_quarantine_dir() ) ) === 0 ) {
        return array( 'already_quarantined', 'This file is already in quarantine.' );
    }
    // Belt and braces: never touch our own plugin.
    if ( strpos( $real, wp_normalize_path( dirname( __DIR__ ) ) ) === 0 && strpos( $rel, 'wp-content/plugins/' . dirname( claude_connector_basename() ) ) === 0 ) {
        return array( 'protected', 'Refusing to quarantine Claude Connector itself.' );
    }
    return true;
}

/**
 * POST /security/quarantine { path } or { paths: [...] } - move added (non-core)
 * files out of the live site into quarantine. Reversible via /security/restore.
 * For malware the security scan found outside wp-content (root, wp-admin,
 * wp-includes) that the file tools cannot reach. With paths, each file is
 * checked on its own and the result lists what was moved and what was refused.
 */
function claude_security_quarantine( $req ) {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    $paths = $req->get_param( 'paths' );
    $batch = is_array( $paths );
    $list  = $batch ? $paths : array( $req->get_param( 'path' ) );
    $list  = array_values( array_filter( array_map( function ( $p ) { return ltrim( wp_normalize_path( (string) $p ), '/' ); }, $list ), 'strlen' ) );
    if ( ! $list ) return new WP_Error( 'missing', 'Give the path of the file to quarantine (path), or several (paths), relative to the WordPress root - e.g. wp-admin/js/widgets/radio.php.', array( 'status' => 400 ) );
    if ( count( $list ) > 50 ) return new WP_Error( 'too_many', 'At most 50 files per call.', array( 'status' => 400 ) );

    $ver  = get_bloginfo( 'version' );
    $sums = get_core_checksums( $ver, get_locale() ) ?: get_core_checksums( $ver, 'en_US' );
    if ( ! is_array( $sums ) || ! $sums ) {
        return new WP_Error( 'no_checksums', "Could not fetch wordpress.org's checksums for WordPress {$ver}, so a core file cannot be told from a planted one - not quarantining anything.", array( 'status' => 502 ) );
    }
    if ( ! $batch ) {
        $r = claude_security_quarantine_one( $list[0], $sums );
        return is_wp_error( $r ) ? $r : new WP_REST_Response( $r );
    }
    $moved = $refused = array();
    foreach ( array_unique( $list ) as $p ) {
        $r = claude_security_quarantine_one( $p, $sums );
        if ( is_wp_error( $r ) ) $refused[] = array( 'path' => $p, 'code' => $r->get_error_code(), 'message' => $r->get_error_message() );
        else $moved[] = $r;
    }
    return new WP_REST_Response( array(
        'quarantined' => $moved,
        'refused'     => $refused,
        'note'        => count( $moved ) . ' moved into wp-content/uploads/.claude-quarantine, ' . count( $refused ) . ' refused. The site no longer loads or serves the moved files; each can be put back with POST /security/restore {"id": ...}.',
    ) );
}

/** Quarantines one file. @return array|WP_Error */
function claude_security_quarantine_one( $input, $sums ) {
    $abs     = wp_normalize_path( ABSPATH ) . '/' . $input;
    $allowed = claude_security_quarantine_allowed( $abs, $sums );
    if ( $allowed !== true ) {
        return new WP_Error( $allowed[0], $allowed[1], array( 'status' => $allowed[0] === 'not_found' ? 404 : 403 ) );
    }

    $real    = realpath( $abs );
    $rel     = ltrim( substr( wp_normalize_path( $real ), strlen( wp_normalize_path( realpath( ABSPATH ) ) ) ), '/' );
    $id      = gmdate( 'Ymd-His' ) . '-' . substr( md5( $rel . microtime() ), 0, 8 );
    $dest    = claude_security_quarantine_dir() . '/' . $id . '.quarantined';
    $size    = filesize( $real );
    $md5     = md5_file( $real );
    $preview = substr( (string) file_get_contents( $real, false, null, 0, 4 * KB_IN_BYTES ), 0, 2000 );
    $preview = function_exists( 'mb_convert_encoding' ) ? mb_convert_encoding( $preview, 'UTF-8', 'UTF-8' ) : wp_check_invalid_utf8( $preview, true );

    if ( ! @rename( $real, $dest ) ) { // phpcs:ignore
        if ( ! @copy( $real, $dest ) || ! @unlink( $real ) ) { // phpcs:ignore
            @unlink( $dest ); // phpcs:ignore
            $why = claude_core_write_problem( dirname( $real ) );
            return new WP_Error( 'move_failed', "Could not move {$rel}: {$why['reason']}.", array( 'status' => 500, 'blocked_by' => $why ) );
        }
    }
    if ( substr( $rel, -4 ) === '.php' && function_exists( 'wp_opcache_invalidate' ) ) wp_opcache_invalidate( $real, true );

    list( $mf_file, $manifest ) = claude_security_manifest();
    $manifest[ $id ] = array( 'original' => $rel, 'size' => $size, 'md5' => $md5, 'at' => gmdate( 'c' ), 'by' => wp_get_current_user()->user_login ?: null, 'restored' => false );
    @file_put_contents( $mf_file, wp_json_encode( $manifest, JSON_PRETTY_PRINT ) ); // phpcs:ignore

    return array(
        'quarantined' => $rel,
        'id'          => $id,
        'size'        => $size,
        'md5'         => $md5,
        'preview'     => $preview,
        'note'        => 'Moved out of the live site into wp-content/uploads/.claude-quarantine. The site no longer loads or serves it. Put it back with POST /security/restore {"id":"' . $id . '"} if needed.',
    );
}

/** GET /security/quarantine - what is currently in quarantine. */
function claude_security_quarantine_list() {
    list( , $manifest ) = claude_security_manifest();
    $items = array();
    foreach ( $manifest as $id => $m ) {
        $items[] = array_merge( array( 'id' => $id ), $m, array( 'in_quarantine' => file_exists( claude_security_quarantine_dir() . '/' . $id . '.quarantined' ) ) );
    }
    usort( $items, function ( $a, $b ) { return strcmp( $b['at'], $a['at'] ); } );
    return new WP_REST_Response( array( 'dir' => 'wp-content/uploads/.claude-quarantine', 'items' => $items ) );
}

/** POST /security/restore { id } - put a quarantined file back where it was. */
function claude_security_restore( $req ) {
    $id = preg_replace( '/[^a-z0-9\-]/', '', (string) $req->get_param( 'id' ) );
    list( $mf_file, $manifest ) = claude_security_manifest();
    if ( $id === '' || ! isset( $manifest[ $id ] ) ) return new WP_Error( 'not_found', 'No quarantined file with that id.', array( 'status' => 404 ) );
    $src = claude_security_quarantine_dir() . '/' . $id . '.quarantined';
    if ( ! is_file( $src ) ) return new WP_Error( 'not_found', 'The quarantined file is gone.', array( 'status' => 404 ) );
    $dest = wp_normalize_path( ABSPATH ) . '/' . $manifest[ $id ]['original'];
    wp_mkdir_p( dirname( $dest ) );
    if ( ! @rename( $src, $dest ) && ! ( @copy( $src, $dest ) && @unlink( $src ) ) ) { // phpcs:ignore
        return new WP_Error( 'restore_failed', 'Could not put the file back.', array( 'status' => 500 ) );
    }
    $manifest[ $id ]['restored'] = gmdate( 'c' );
    @file_put_contents( $mf_file, wp_json_encode( $manifest, JSON_PRETTY_PRINT ) ); // phpcs:ignore
    return new WP_REST_Response( array( 'restored' => $manifest[ $id ]['original'] ) );
}

/**
 * POST /security/reinstall-core - restore every WordPress core file to the
 * official copy for the SAME version already installed, using WordPress's own
 * core upgrader (the "Re-install" button on Dashboard > Updates). This replaces
 * modified core files and puts missing ones back - including in the site root,
 * wp-admin and wp-includes, which the file tools cannot reach - and does not
 * touch wp-content. Same version only: it never changes the WordPress version.
 */
function claude_security_reinstall_core() {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
    @set_time_limit( 300 ); // phpcs:ignore

    $fs = claude_maint_filesystem();
    if ( is_wp_error( $fs ) ) return $fs;

    $ver  = get_bloginfo( 'version' );
    $sums = get_core_checksums( $ver, get_locale() ) ?: get_core_checksums( $ver, 'en_US' );

    // Count core files that differ or are missing, before and after, for the report.
    $tally = function () use ( $sums ) {
        $modified = $missing = 0;
        if ( ! is_array( $sums ) ) return null;
        foreach ( $sums as $file => $md5 ) {
            if ( strpos( $file, 'wp-content/' ) === 0 ) continue;
            $abs = ABSPATH . $file;
            if ( ! file_exists( $abs ) ) { $missing++; continue; }
            if ( md5_file( $abs ) !== $md5 ) $modified++;
        }
        return array( 'modified' => $modified, 'missing' => $missing );
    };
    $before = $tally();

    // Core files are the same whatever the site's language (translations live in
    // wp-content/languages), so the en_US no-content package is correct and skips wp-content.
    $pkg_full = 'https://downloads.wordpress.org/release/wordpress-' . $ver . '.zip';
    $pkg_nc   = 'https://downloads.wordpress.org/release/wordpress-' . $ver . '-no-content.zip';
    $update   = (object) array(
        'response' => 'reinstall',
        'packages' => (object) array( 'full' => $pkg_full, 'no_content' => $pkg_nc, 'partial' => false, 'new_bundled' => false, 'rollback' => false ),
        'current'  => $ver,
        'version'  => $ver,
        'download' => $pkg_full,
        'locale'   => 'en_US',
    );

    $maintenance = ABSPATH . '.maintenance';
    $had_maint   = file_exists( $maintenance );
    $skin = new Automatic_Upgrader_Skin();
    add_filter( 'update_feedback', '__return_false' );
    ob_start();
    $result = ( new Core_Upgrader( $skin ) )->upgrade( $update, array( 'pre_check_md5' => false, 'do_rollback' => false ) );
    $stray  = trim( wp_strip_all_tags( (string) ob_get_clean() ) );
    remove_filter( 'update_feedback', '__return_false' );

    if ( ! $had_maint && file_exists( $maintenance ) ) @unlink( $maintenance ); // phpcs:ignore

    // Never trust the upgrader's answer alone: it stops at the first file it
    // cannot write (an error), quietly gives up when it cannot write to the site
    // root (false, no message), and can report success with files left unfixed.
    // Check the files, and restore what is left one by one.
    $why = null;
    if ( is_wp_error( $result ) ) {
        $data = $result->get_error_data();
        $why  = array( 'code' => $result->get_error_code(), 'message' => $result->get_error_message() . ( $stray ? " ({$stray})" : '' ), 'file' => is_string( $data ) && $data !== '' ? $data : null );
    } elseif ( ! $result ) {
        $why = array( 'code' => 'no_write_access', 'message' => 'WordPress could not get write access to the site root, so it did not start', 'file' => null );
    } else {
        claude_cc_opcache_flush();
        $after = $tally();
        if ( $after && ( $after['modified'] || $after['missing'] ) ) {
            $why = array( 'code' => 'incomplete', 'message' => "WordPress reported success, but {$after['modified']} core files still differ and {$after['missing']} are still missing", 'file' => null );
        } else {
            return new WP_REST_Response( array(
                'version'  => $ver,
                'method'   => 'upgrader',
                'complete' => true,
                'before'   => $before,
                'after'    => $after,
                'restored' => ( $before && $after ) ? array( 'modified' => $before['modified'] - $after['modified'], 'missing' => $before['missing'] - $after['missing'] ) : null,
                'health'   => claude_loopback_health(),
                'note'     => 'WordPress ' . $ver . ' core files were reinstalled from wordpress.org. wp-content (plugins, themes, uploads) was not touched. Planted files that are NOT part of core are not removed by this - use quarantine for those.',
            ) );
        }
    }

    $said = $why['message'] . ( $why['file'] ? " (at {$why['file']})" : '' );
    if ( 'direct' !== get_filesystem_method() ) {
        return new WP_Error( 'reinstall_failed', "Core reinstall failed: {$said}. Restoring file by file needs direct file access, which this host does not give WordPress.", array( 'status' => 500, 'upgrader' => $why ) );
    }
    $fb = claude_security_restore_core_files( $ver );
    if ( is_wp_error( $fb ) ) {
        return new WP_Error( 'reinstall_failed', "Core reinstall failed: {$said}. Restoring file by file also failed: " . $fb->get_error_message(), array( 'status' => 500, 'upgrader' => $why ) );
    }
    claude_cc_opcache_flush();
    $after = $tally();
    $n_ok  = count( $fb['restored'] );
    $n_bad = count( $fb['failed'] );
    if ( $n_bad ) {
        $note = "WordPress's own reinstall did not finish ({$said}), so core files were restored one by one: {$n_ok} restored, {$n_bad} could not be written. blocked_by lists the folders or files that refused the write, with their owner, permissions and the likely reason - the host needs to fix those (give them that list), then run this again.";
    } elseif ( $n_ok ) {
        $note = "WordPress's own reinstall did not finish ({$said}), so core files were restored one by one instead: all {$n_ok} missing or modified core files now match WordPress {$ver}.";
    } else {
        $note = "Every core file already matches the official WordPress {$ver} package.";
    }
    if ( $fb['chmodded'] ) $note .= ' Some read-only folders or files were reset to standard permissions first - see permissions_fixed.';
    return new WP_REST_Response( array(
        'version'           => $ver,
        'method'            => 'file_by_file',
        'complete'          => ! $n_bad,
        'upgrader'          => $why,
        'before'            => $before,
        'after'             => $after,
        'restored_count'    => $n_ok,
        'restored'          => array_slice( $fb['restored'], 0, 60 ),
        'not_restored'      => $n_bad,
        'failed'            => array_slice( $fb['failed'], 0, 60, true ),
        'blocked_by'        => $fb['blocked'],
        'permissions_fixed' => $fb['chmodded'],
        'health'            => claude_loopback_health(),
        'note'              => $note,
    ) );
}

/**
 * The file tools' refusal for a path outside wp-content, pointing at the tools
 * that do reach the site root, wp-admin and wp-includes.
 */
function claude_outside_wp_content() {
    return new WP_Error( 'forbidden', 'Path is outside wp-content - the file tools only reach wp-content. Outside it (site root, wp-admin, wp-includes): list folders and read files with GET /security/core-file?path= (MCP wp_site_files), restore WordPress core files with POST /security/reinstall-core (wp_reinstall_core), and move planted files that are not part of WordPress out of the site with POST /security/quarantine {"paths": [...]} (wp_quarantine_file).', array( 'status' => 403 ) );
}

/**
 * Core reinstall fallback: copy every missing or modified core file from the
 * official package one at a time, so one unwritable folder does not stop the
 * rest. Each file goes to a temporary name in its folder and is then renamed
 * over the old one, so a failed write never leaves a half-written file. A
 * folder or file the site owns but that was made read-only (a common malware
 * trick) is reset to WordPress's standard permissions first.
 *
 * @return array|WP_Error  restored (paths), failed (path => blocking path),
 *                         blocked (why, per blocking path), chmodded.
 */
function claude_security_restore_core_files( $ver ) {
    global $wp_filesystem;
    $pkg = download_url( 'https://downloads.wordpress.org/release/wordpress-' . $ver . '-no-content.zip', 300 );
    if ( is_wp_error( $pkg ) ) return $pkg;
    $work  = WP_CONTENT_DIR . '/upgrade/claude-core-' . wp_generate_password( 8, false, false );
    $unzip = unzip_file( $pkg, $work );
    @unlink( $pkg ); // phpcs:ignore
    if ( is_wp_error( $unzip ) ) {
        $wp_filesystem->delete( $work, true );
        return $unzip;
    }

    $src      = wp_normalize_path( $work . '/wordpress' );
    $restored = $failed = $blocked = $chmodded = array();
    $files    = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $src, FilesystemIterator::SKIP_DOTS ) );
    foreach ( $files as $f ) {
        if ( ! $f->isFile() ) continue;
        $from = wp_normalize_path( $f->getPathname() );
        $rel  = ltrim( substr( $from, strlen( $src ) ), '/' );
        if ( strpos( $rel, 'wp-content/' ) === 0 ) continue;
        $to  = ABSPATH . $rel;
        $md5 = md5_file( $from );
        if ( is_file( $to ) && md5_file( $to ) === $md5 ) continue;

        $dir = dirname( $to );
        if ( ! is_dir( $dir ) ) {
            $parent = $dir;
            while ( ! is_dir( $parent ) && dirname( $parent ) !== $parent ) $parent = dirname( $parent );
            claude_core_make_writable( $parent, $chmodded );
            wp_mkdir_p( $dir );
        }
        if ( is_dir( $dir ) ) {
            claude_core_make_writable( $dir, $chmodded );
            $tmp = $to . '.claude-tmp';
            if ( @copy( $from, $tmp ) ) { // phpcs:ignore
                @chmod( $tmp, defined( 'FS_CHMOD_FILE' ) ? FS_CHMOD_FILE : 0644 ); // phpcs:ignore
                if ( @rename( $tmp, $to ) || ( @copy( $tmp, $to ) && @unlink( $tmp ) ) ) { // phpcs:ignore
                    clearstatcache( true, $to );
                    if ( md5_file( $to ) === $md5 ) {
                        $restored[] = $rel;
                        continue;
                    }
                }
                @unlink( $tmp ); // phpcs:ignore
            }
        }
        // A folder that is missing or unwritable blocks the file; otherwise the file itself is locked.
        $why = claude_core_write_problem( ( ! is_dir( $dir ) || ! is_writable( $dir ) || ! is_file( $to ) ) ? $dir : $to );
        $failed[ $rel ]          = $why['path'];
        $blocked[ $why['path'] ] = $why;
    }
    $wp_filesystem->delete( $work, true );
    return array( 'restored' => $restored, 'failed' => $failed, 'blocked' => array_values( $blocked ), 'chmodded' => $chmodded );
}

/** Path relative to the WordPress root, for reports. */
function claude_core_rel( $path ) {
    $rel = ltrim( substr( wp_normalize_path( $path ), strlen( wp_normalize_path( ABSPATH ) ) ), '/' );
    return $rel === '' ? '(site root)' : $rel;
}

/**
 * Makes a folder or file writable when the site's own account owns it but it is
 * read-only, using WordPress's standard permissions (0755 folders, 0644 files).
 * Records each change in $chmodded.
 */
function claude_core_make_writable( $path, &$chmodded ) {
    clearstatcache( true, $path );
    if ( is_writable( $path ) ) return true;
    $mode = is_dir( $path ) ? ( defined( 'FS_CHMOD_DIR' ) ? FS_CHMOD_DIR : 0755 ) : ( defined( 'FS_CHMOD_FILE' ) ? FS_CHMOD_FILE : 0644 );
    $old  = substr( sprintf( '%o', (int) @fileperms( $path ) ), -4 ); // phpcs:ignore
    if ( @chmod( $path, $mode ) ) { // phpcs:ignore
        clearstatcache( true, $path );
        if ( is_writable( $path ) ) {
            $chmodded[] = array( 'path' => claude_core_rel( $path ), 'from' => $old, 'to' => sprintf( '%04o', $mode ) );
            return true;
        }
    }
    return false;
}

/**
 * Why WordPress cannot write to a path: its owner and permissions against the
 * user PHP runs as, in words a host can act on.
 */
function claude_core_write_problem( $path ) {
    while ( ! file_exists( $path ) && dirname( $path ) !== $path ) $path = dirname( $path );
    clearstatcache( true, $path );
    $name  = function ( $id ) {
        if ( $id === false || $id === null ) return '?';
        if ( function_exists( 'posix_getpwuid' ) ) {
            $p = @posix_getpwuid( $id ); // phpcs:ignore
            if ( $p ) return $p['name'];
        }
        return (string) $id;
    };
    $uid   = @fileowner( $path ); // phpcs:ignore
    $me    = function_exists( 'posix_geteuid' ) ? posix_geteuid() : null;
    $mode  = (int) @fileperms( $path ); // phpcs:ignore
    $perms = substr( sprintf( '%o', $mode ), -4 );
    $what  = is_dir( $path ) ? 'folder' : 'file';
    if ( is_writable( $path ) ) {
        $reason = "the {$what} is writable, but the server still refused the write - usually a server security tool (e.g. Imunify360 or a file lock) or a full disk quota";
    } elseif ( $me !== null && $uid !== false && $uid !== $me ) {
        $reason = "the {$what} belongs to " . $name( $uid ) . ', but WordPress runs as ' . $name( $me ) . ' - the host needs to give it back to the hosting account';
    } elseif ( ! ( $mode & 0200 ) ) {
        $reason = "the {$what} is read-only ({$perms}) and could not be reset - the host needs to make it writable (0755 for folders, 0644 for files)";
    } else {
        $reason = "the {$what} has normal permissions ({$perms}) but is locked against changes - an immutable flag or a server security tool; the host needs to unlock it";
    }
    return array(
        'path'     => claude_core_rel( $path ),
        'type'     => $what,
        'perms'    => $perms,
        'owner'    => $name( $uid ),
        'php_user' => $me !== null ? $name( $me ) : null,
        'reason'   => $reason,
    );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Site-root .htaccess: review it, and restore WordPress's standard rules
//
//  The file is read as segments - each "# BEGIN x ... # END x" block, and each
//  run of loose lines between them. The WordPress block is always regenerated
//  by WordPress itself; blocks from known plugins and hosts are kept; segments
//  with lines typical of an injection are flagged. Restoring drops the flagged
//  segments (or the ones chosen), keeps a copy of the old file in quarantine,
//  checks the site and a real page afterwards, and puts the old file back if
//  either breaks.
// ──────────────────────────────────────────────────────────────────────────────

/** A friendly name for a "# BEGIN x" block that a well-known plugin or host writes, or null. */
function claude_htaccess_known( $name ) {
    $n   = strtolower( (string) $name );
    $map = array(
        'wordpress' => 'WordPress permalinks', 'wordfence' => 'Wordfence', 'lscache' => 'LiteSpeed Cache', 'litespeed' => 'LiteSpeed',
        'wp rocket' => 'WP Rocket', 'w3tc' => 'W3 Total Cache', 'supercache' => 'WP Super Cache', 'fastestcache' => 'WP Fastest Cache',
        'really simple' => 'Really Simple Security', 'rlrssslreallysimplessl' => 'Really Simple Security', 'ithemes' => 'Solid Security',
        'solid security' => 'Solid Security', 'aiowps' => 'All-In-One Security', 'all in one wp security' => 'All-In-One Security',
        'bulletproof' => 'BulletProof Security', 'sucuri' => 'Sucuri', 'sg optimizer' => 'SiteGround Optimizer', 'sgo ' => 'SiteGround Optimizer',
        'hummingbird' => 'Hummingbird', 'autoptimize' => 'Autoptimize', 'imagify' => 'Imagify', 'ewww' => 'EWWW Image Optimizer',
        'shortpixel' => 'ShortPixel', 'webp express' => 'WebP Express', 'converter for media' => 'Converter for Media',
        'cpanel-generated' => 'cPanel PHP version', 'ninjafirewall' => 'NinjaFirewall', 'malcare' => 'MalCare', 'wp-optimize' => 'WP-Optimize',
        'breeze' => 'Breeze', 'nitropack' => 'NitroPack',
    );
    foreach ( $map as $k => $label ) {
        if ( strpos( $n, $k ) !== false ) return $label;
    }
    return null;
}

/** Why a single .htaccess line looks like an injection, or null. */
function claude_htaccess_line_flag( $line ) {
    $l = trim( (string) $line );
    if ( $l === '' || $l[0] === '#' ) return null;
    $host = preg_quote( preg_replace( '/^www\./', '', strtolower( (string) parse_url( home_url(), PHP_URL_HOST ) ) ), '/' );
    if ( preg_match( '/^(?:RewriteRule|Redirect(?:Match|Permanent|Temp)?|ErrorDocument)\b.*\bhttps?:\/\/(?!(?:www\.)?' . $host . '\b|%\{HTTP_HOST\}|%\{SERVER_NAME\})/i', $l ) ) {
        return 'sends visitors to another site';
    }
    if ( preg_match( '/^RewriteCond\s+%\{HTTP_(?:USER_AGENT|REFERER)\}.*(?:google|bing|yahoo|baidu|yandex|duckduck|facebook|android|iphone|mobile)/i', $l ) ) {
        return 'only applies to search engines, search visitors or mobile visitors - typical of spam redirects';
    }
    if ( preg_match( '/^php_value\s+auto_(?:prepend|append)_file\s+["\']?([^"\'\s]+)/i', $l, $m ) ) {
        $target = $m[1];
        if ( basename( $target ) === 'wordfence-waf.php' && claude_security_wordfence_waf( file_exists( $target ) ? $target : ABSPATH . 'wordfence-waf.php' ) === true ) return null;
        if ( preg_match( '/(?:\.htninja|malcare-waf\.php)$/', $target ) ) return null;
        return 'makes PHP load ' . $target . ' before every request';
    }
    if ( preg_match( '/^(?:AddHandler|AddType|SetHandler)\b.*(?:php|x-httpd)/i', $l ) && preg_match( '/\.(?:jpe?g|png|gif|ico|svg|webp|txt|css|js|pdf|zip)\b/i', $l ) ) {
        return 'runs image or text files as PHP';
    }
    return null;
}

/** The file as segments: marker blocks, and runs of loose lines (split at blank lines). */
function claude_htaccess_segments( $text ) {
    $segs = array();
    $cur  = null;
    $flush = function () use ( &$segs, &$cur ) {
        if ( $cur && trim( implode( '', $cur['lines'] ) ) !== '' ) $segs[] = $cur;
        $cur = null;
    };
    foreach ( preg_split( '/\r\n|\r|\n/', (string) $text ) as $i => $line ) {
        $in_block = $cur && $cur['kind'] === 'block';
        if ( ! $in_block && preg_match( '/^\s*#\s*(?:php\s*--\s*)?BEGIN\s+(.+?)\s*$/i', $line, $m ) ) {
            $flush();
            $cur = array( 'kind' => 'block', 'name' => $m[1], 'start' => $i + 1, 'lines' => array( $line ) );
            continue;
        }
        if ( $in_block ) {
            $cur['lines'][] = $line;
            if ( preg_match( '/^\s*#\s*(?:php\s*--\s*)?END\s+/i', $line ) ) $flush();
            continue;
        }
        if ( trim( $line ) === '' ) { $flush(); continue; }
        if ( ! $cur ) $cur = array( 'kind' => 'lines', 'name' => null, 'start' => $i + 1, 'lines' => array() );
        $cur['lines'][] = $line;
    }
    $flush();
    foreach ( $segs as $k => &$seg ) {
        $seg['id']    = 's' . ( $k + 1 );
        $seg['known'] = $seg['kind'] === 'block' ? claude_htaccess_known( $seg['name'] ) : null;
        $seg['flags'] = array();
        foreach ( $seg['lines'] as $j => $line ) {
            $why = claude_htaccess_line_flag( $line );
            if ( $why ) $seg['flags'][] = array( 'line' => $seg['start'] + $j, 'text' => trim( substr( $line, 0, 200 ) ), 'why' => $why );
        }
    }
    unset( $seg );
    return $segs;
}

/** Loads the most recently changed published page or post and returns its status code. */
function claude_htaccess_probe() {
    $p   = get_posts( array( 'numberposts' => 1, 'post_status' => 'publish', 'post_type' => array( 'page', 'post' ), 'orderby' => 'modified' ) );
    $url = $p ? get_permalink( $p[0] ) : home_url( '/' );
    $r   = wp_remote_get( $url, array( 'timeout' => 20, 'redirection' => 5, 'sslverify' => apply_filters( 'https_local_ssl_verify', false ), 'headers' => array( 'Cache-Control' => 'no-cache' ) ) );
    return array( 'url' => $url, 'code' => is_wp_error( $r ) ? 0 : (int) wp_remote_retrieve_response_code( $r ) );
}

/**
 * GET /security/htaccess - the site-root .htaccess as segments, with what each
 * is and any line that looks injected. POST { remove?: [segment ids],
 * expected_md5? } - restore it (see the section comment above).
 */
function claude_security_htaccess( $req ) {
    if ( $req->get_method() === 'POST' ) return claude_security_htaccess_restore( $req );
    $file = ABSPATH . '.htaccess';
    if ( ! file_exists( $file ) ) {
        return new WP_REST_Response( array( 'exists' => false, 'note' => 'This site has no .htaccess in its root. Sites on nginx do not use one.' ) );
    }
    $text = (string) file_get_contents( $file );
    $segs = claude_htaccess_segments( $text );
    return new WP_REST_Response( array(
        'exists'     => true,
        'size'       => strlen( $text ),
        'modified'   => wp_date( 'Y-m-d H:i:s', filemtime( $file ) ),
        'md5'        => md5( $text ),
        'multisite'  => is_multisite(),
        'segments'   => array_map( function ( $s ) {
            return array( 'id' => $s['id'], 'kind' => $s['kind'], 'name' => $s['name'], 'known' => $s['known'], 'start_line' => $s['start'], 'text' => implode( "\n", $s['lines'] ), 'flags' => $s['flags'] );
        }, $segs ),
        'flagged'    => array_values( array_map( function ( $s ) { return $s['id']; }, array_filter( $segs, function ( $s ) { return $s['flags'] && strcasecmp( (string) $s['name'], 'WordPress' ) !== 0; } ) ) ),
        'note'       => 'Restoring (POST) regenerates the WordPress block, removes the segments listed in "remove" (default: the flagged ones), keeps everything else, saves a copy of the current file in quarantine, and puts it back automatically if the site or a page stops loading.',
    ) );
}

function claude_security_htaccess_restore( $req ) {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    global $wp_rewrite;
    if ( is_multisite() ) {
        return new WP_Error( 'multisite', 'A multisite network\'s .htaccess has its own rules - fix it by hand.', array( 'status' => 400 ) );
    }
    $file = ABSPATH . '.htaccess';
    if ( ! file_exists( $file ) ) return new WP_Error( 'no_htaccess', 'This site has no .htaccess in its root.', array( 'status' => 404 ) );
    $text = (string) file_get_contents( $file );
    $want = (string) $req->get_param( 'expected_md5' );
    if ( $want !== '' && $want !== md5( $text ) ) {
        return new WP_Error( 'changed', '.htaccess changed since it was reviewed - review it again first.', array( 'status' => 409 ) );
    }
    $segs   = claude_htaccess_segments( $text );
    $remove = $req->get_param( 'remove' );
    $remove = is_array( $remove )
        ? array_map( 'strval', $remove )
        : array_values( array_map( function ( $s ) { return $s['id']; }, array_filter( $segs, function ( $s ) { return (bool) $s['flags']; } ) ) );

    $out = $removed = $kept = array();
    foreach ( $segs as $s ) {
        if ( $s['kind'] === 'block' && strcasecmp( $s['name'], 'WordPress' ) === 0 ) {
            $out[] = "# BEGIN WordPress\n# END WordPress"; // refilled by WordPress below
            continue;
        }
        if ( in_array( $s['id'], $remove, true ) ) {
            $removed[] = array( 'id' => $s['id'], 'name' => $s['name'] ?: 'loose lines from line ' . $s['start'], 'text' => implode( "\n", $s['lines'] ), 'flags' => $s['flags'] );
            continue;
        }
        $out[]  = implode( "\n", $s['lines'] );
        $kept[] = $s['known'] ?: ( $s['name'] ?: 'loose lines from line ' . $s['start'] );
    }

    // A copy of the current file, restorable like any quarantined file.
    $id   = gmdate( 'Ymd-His' ) . '-' . substr( md5( '.htaccess' . microtime() ), 0, 8 );
    $copy = claude_security_quarantine_dir() . '/' . $id . '.quarantined';
    if ( ! @copy( $file, $copy ) ) return new WP_Error( 'backup_failed', 'Could not save a copy of .htaccess first, so nothing was changed.', array( 'status' => 500 ) ); // phpcs:ignore
    list( $mf_file, $manifest ) = claude_security_manifest();
    $manifest[ $id ] = array( 'original' => '.htaccess', 'size' => strlen( $text ), 'md5' => md5( $text ), 'at' => gmdate( 'c' ), 'by' => wp_get_current_user()->user_login ?: null, 'restored' => false, 'note' => 'copy saved before the .htaccess restore' );
    @file_put_contents( $mf_file, wp_json_encode( $manifest, JSON_PRETTY_PRINT ) ); // phpcs:ignore

    $before = claude_htaccess_probe();
    $tmp    = $file . '.claude-tmp';
    if ( @file_put_contents( $tmp, implode( "\n\n", $out ) . "\n" ) === false ) { // phpcs:ignore
        return new WP_Error( 'write_failed', 'Could not write the new .htaccess - nothing was changed.', array( 'status' => 500, 'blocked_by' => claude_core_write_problem( ABSPATH ) ) );
    }
    $rules = $wp_rewrite->using_mod_rewrite_permalinks() ? explode( "\n", trim( $wp_rewrite->mod_rewrite_rules() ) ) : array();
    insert_with_markers( $tmp, 'WordPress', $rules );
    @chmod( $tmp, fileperms( $file ) & 0777 ); // phpcs:ignore
    if ( ! @rename( $tmp, $file ) ) { // phpcs:ignore
        @unlink( $tmp ); // phpcs:ignore
        $why = claude_core_write_problem( $file );
        return new WP_Error( 'write_failed', "Could not replace .htaccess: {$why['reason']}. Nothing was changed.", array( 'status' => 500, 'blocked_by' => $why ) );
    }

    $health = claude_loopback_health();
    $after  = claude_htaccess_probe();
    $ok     = function ( $c ) { return $c >= 200 && $c < 400; };
    if ( $health['status'] === 'fatal' || ( $ok( $before['code'] ) && ! $ok( $after['code'] ) ) ) {
        @file_put_contents( $file, $text ); // phpcs:ignore
        return new WP_Error( 'reverted', 'The site or a page stopped loading with the new .htaccess, so the old one was put back. Nothing changed.', array( 'status' => 500, 'health' => $health, 'page_check' => array( 'url' => $before['url'], 'before' => $before['code'], 'after' => $after['code'] ) ) );
    }
    return new WP_REST_Response( array(
        'removed'         => $removed,
        'kept'            => $kept,
        'wordpress_rules' => count( $rules ),
        'backup_id'       => $id,
        'health'          => $health,
        'page_check'      => array( 'url' => $before['url'], 'before' => $before['code'], 'after' => $after['code'] ),
        'note'            => count( $removed ) . ' segment' . ( count( $removed ) === 1 ? '' : 's' ) . ' removed and the WordPress rules regenerated; ' . count( $kept ) . ' kept. The old file is in quarantine - POST /security/restore {"id":"' . $id . '"} puts it back.',
    ) );
}

/**
 * Fallback for older WordPress without wp_opcache_flush_after_update().
 */
function claude_cc_opcache_flush() {
    if ( function_exists( 'wp_opcache_flush_after_update' ) ) wp_opcache_flush_after_update( true );
    elseif ( function_exists( 'opcache_reset' ) ) @opcache_reset(); // phpcs:ignore
}

/**
 * GET /security/core-file?path=wp-includes/x.php - a WordPress core file and
 * what differs from the official copy for this version; or, for a file that is
 * NOT part of WordPress (a planted file in the root, wp-admin or wp-includes),
 * its content and malware-pattern hits, so it can be examined before it is
 * quarantined. Read-only, inside the WordPress folder only, never wp-config.php.
 */
function claude_security_core_file( $req ) {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    $path = ltrim( wp_normalize_path( (string) $req->get_param( 'path' ) ), '/' );
    $ver  = get_bloginfo( 'version' );
    $sums = get_core_checksums( $ver, get_locale() ) ?: get_core_checksums( $ver, 'en_US' );
    if ( ! is_array( $sums ) || ! $sums ) {
        return new WP_Error( 'no_checksums', "Could not fetch wordpress.org's checksums for WordPress {$ver}.", array( 'status' => 502 ) );
    }
    if ( in_array( $path, array( '', '.' ), true ) ) return claude_security_list_dir( realpath( ABSPATH ), $sums );
    if ( strpos( $path, 'wp-content/' ) === 0 || $path === 'wp-content' ) {
        return new WP_Error( 'in_wp_content', 'Files in wp-content: use /files/read (MCP wp_files_read).', array( 'status' => 400 ) );
    }
    $abs  = ABSPATH . $path;
    $real = realpath( $abs );
    if ( $real === false ) return new WP_REST_Response( array( 'path' => $path, 'version' => $ver, 'exists' => false, 'core' => isset( $sums[ $path ] ) ) );
    if ( strpos( wp_normalize_path( $real ), wp_normalize_path( realpath( ABSPATH ) ) . '/' ) !== 0 ) {
        return new WP_Error( 'forbidden', 'Path is outside the WordPress folder.', array( 'status' => 403 ) );
    }
    if ( ! isset( $sums[ $path ] ) ) return claude_security_other_file( $real, $ver );
    $local    = (string) file_get_contents( $real, false, null, 0, 2 * MB_IN_BYTES );
    $modified = md5( $local ) !== $sums[ $path ];
    $out      = array(
        'path'         => $path,
        'version'      => $ver,
        'exists'       => true,
        'modified'     => $modified,
        'size'         => strlen( $local ),
        'modified_at'  => wp_date( 'Y-m-d H:i:s', filemtime( $real ) ),
        'official_md5' => $sums[ $path ],
        'local_md5'    => md5( $local ),
    );
    if ( $modified ) {
        $r = wp_remote_get( 'https://core.svn.wordpress.org/tags/' . rawurlencode( $ver ) . '/' . implode( '/', array_map( 'rawurlencode', explode( '/', $path ) ) ), array( 'timeout' => 20 ) );
        $official = ! is_wp_error( $r ) && wp_remote_retrieve_response_code( $r ) === 200 ? (string) wp_remote_retrieve_body( $r ) : null;
        if ( $official !== null && md5( $official ) === $sums[ $path ] ) {
            require_once ABSPATH . WPINC . '/wp-diff.php';
            $diff     = new Text_Diff( explode( "\n", $official ), explode( "\n", $local ) );
            $renderer = new Text_Diff_Renderer( array( 'leading_context_lines' => 2, 'trailing_context_lines' => 2 ) );
            // Normal diff: "<" lines are the official file, ">" lines are this site's.
            $out['diff']      = substr( (string) $renderer->render( $diff ), 0, 200 * KB_IN_BYTES );
            $out['diff_note'] = 'Lines starting "<" are the official WordPress file, ">" are this site\'s copy.';
        } else {
            $out['diff_note'] = 'The official copy could not be fetched from wordpress.org, so no diff - compare by hand.';
        }
    }
    if ( rest_sanitize_boolean( $req->get_param( 'content' ) ) ) $out['content'] = substr( $local, 0, 400 * KB_IN_BYTES );
    return new WP_REST_Response( $out );
}

/**
 * A file inside the WordPress folder that is not part of WordPress core, read-only.
 */
function claude_security_other_file( $real, $ver ) {
    $rel = ltrim( substr( wp_normalize_path( $real ), strlen( wp_normalize_path( realpath( ABSPATH ) ) ) ), '/' );
    if ( strtolower( basename( $rel ) ) === 'wp-config.php' ) {
        return new WP_Error( 'protected', 'wp-config.php holds the database password and is never read through the connector.', array( 'status' => 403 ) );
    }
    if ( is_dir( $real ) ) {
        $ver  = get_bloginfo( 'version' );
        $sums = get_core_checksums( $ver, get_locale() ) ?: get_core_checksums( $ver, 'en_US' );
        return claude_security_list_dir( $real, is_array( $sums ) ? $sums : array() );
    }
    $size = filesize( $real );
    $raw  = (string) file_get_contents( $real, false, null, 0, 400 * KB_IN_BYTES );
    // Malware often carries bytes that are not valid UTF-8, which would break the JSON response.
    $text = function_exists( 'mb_convert_encoding' ) ? mb_convert_encoding( $raw, 'UTF-8', 'UTF-8' ) : wp_check_invalid_utf8( $raw, true );
    return new WP_REST_Response( array(
        'path'             => $rel,
        'version'          => $ver,
        'exists'           => true,
        'core'             => false,
        'size'             => $size,
        'modified_at'      => wp_date( 'Y-m-d H:i:s', filemtime( $real ) ),
        'md5'              => md5_file( $real ),
        'malware_patterns' => claude_security_scan_file( $real, claude_security_patterns() ),
        'content'          => $text,
        'truncated'        => $size > strlen( $raw ),
        'invalid_utf8'     => $text !== $raw,
        'note'             => "Not part of WordPress {$ver}: wordpress.org's checksums have no file at this path. If it is malicious, or has no reason to be here, and the user agrees, move it out of the site with POST /security/quarantine (MCP wp_quarantine_file) - it can be put back.",
    ) );
}

/**
 * Whether a file is Wordfence's genuine firewall loader (wordfence-waf.php in
 * the site root): a few lines that only include Wordfence's own
 * waf/bootstrap.php. Malware sometimes borrows the name, so the content is
 * checked, not just the filename.
 *
 * @return bool|null  true genuine, false named like it but not genuine, null not that file.
 */
function claude_security_wordfence_waf( $abs ) {
    if ( strtolower( basename( $abs ) ) !== 'wordfence-waf.php' ) return null;
    $size = (int) @filesize( $abs ); // phpcs:ignore
    if ( ! $size || $size > 4 * KB_IN_BYTES ) return false;
    $code = (string) @file_get_contents( $abs ); // phpcs:ignore
    if ( strpos( $code, 'wordfence/waf/bootstrap.php' ) === false ) return false;
    if ( preg_match( '/\$_(?:GET|POST|REQUEST|COOKIE|SERVER|FILES)|\b(?:eval|assert|base64_decode|gzinflate|str_rot13|system|exec|shell_exec|passthru|popen|proc_open|create_function|curl_exec|file_get_contents|fopen)\s*\(|\\\\x[0-9a-f]{2}/i', $code ) ) return false;
    preg_match_all( '/\b(?:include|require)(?:_once)?\b\s*\(?\s*([^;]+);/i', $code, $m );
    if ( ! $m[1] ) return false;
    foreach ( $m[1] as $target ) {
        if ( strpos( $target, 'wordfence/waf/bootstrap.php' ) === false ) return false;
    }
    return true;
}

/**
 * The file PHP loads before every request (auto_prepend_file), resolved, or ''.
 * Removing it takes the whole site down, so it is never quarantined.
 */
function claude_security_prepend_file() {
    $f = (string) ini_get( 'auto_prepend_file' );
    if ( $f === '' ) return '';
    $r = realpath( $f ) ?: realpath( ABSPATH . $f );
    return $r ? wp_normalize_path( $r ) : '';
}

/** Widget / embed domains the security check trusts on top of its built-in list. */
function claude_trusted_hosts() {
    return array_values( array_filter( (array) get_option( 'claude_trusted_hosts', array() ), 'is_string' ) );
}

/** "widget.example.com" entries from a list or text (a pasted URL is reduced to its host). */
function claude_trusted_hosts_clean( $list ) {
    $items = is_array( $list ) ? $list : preg_split( '/[\s,;]+/', (string) $list );
    $out   = array();
    foreach ( $items as $h ) {
        $h = strtolower( trim( (string) $h ) );
        if ( preg_match( '#^[a-z]+://([^/:]+)#', $h, $m ) ) $h = $m[1];
        $h = preg_replace( '/^\*\.|\.$/', '', $h );
        // Shared storage / hosting anyone can put files on is never trusted as a whole.
        if ( preg_match( '/^(?:(?:s3(?:[.-][a-z0-9-]+)?\.)?amazonaws\.com|(?:storage\.|firebasestorage\.)?googleapis\.com|(?:raw\.|objects\.)?githubusercontent\.com|googleusercontent\.com|cloudfront\.net|github\.io|blob\.core\.windows\.net|r2\.dev|pages\.dev|workers\.dev|netlify\.app|vercel\.app|herokuapp\.com|web\.app|firebaseapp\.com|digitaloceanspaces\.com|backblazeb2\.com)$/', $h ) ) continue;
        if ( preg_match( '/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/', $h ) && ! in_array( $h, $out, true ) ) $out[] = $h;
    }
    return array_slice( $out, 0, 300 );
}

/** GET / POST /security/trusted-hosts { hosts: [...] } - widget domains the security check trusts. */
function claude_security_trusted_hosts( $req ) {
    if ( $req->get_method() === 'POST' ) {
        update_option( 'claude_trusted_hosts', claude_trusted_hosts_clean( $req->get_param( 'hosts' ) ), false );
    }
    return new WP_REST_Response( array( 'hosts' => claude_trusted_hosts() ) );
}

/** The administrator emails the security check trusts (see the settings page). */
function claude_trusted_admins() {
    return array_values( array_filter( (array) get_option( 'claude_trusted_admins', array() ), 'is_string' ) );
}

/** "x@y.com" and "@domain.com" entries from a list or text, lower-cased and de-duplicated. */
function claude_trusted_clean( $list ) {
    $items = is_array( $list ) ? $list : preg_split( '/[\s,;]+/', (string) $list );
    $out   = array();
    foreach ( $items as $e ) {
        $e = strtolower( trim( (string) $e ) );
        if ( preg_match( '/<([^>]+)>/', $e, $m ) ) $e = trim( $m[1] );
        if ( ( is_email( $e ) || preg_match( '/^@[a-z0-9.-]+\.[a-z]{2,}$/', $e ) ) && ! in_array( $e, $out, true ) ) $out[] = $e;
    }
    return array_slice( $out, 0, 200 );
}

/** 'email' when the address is on the list, 'domain' when only its domain is, else null. */
function claude_trusted_match( $email, $list ) {
    $e = strtolower( trim( (string) $email ) );
    if ( $e === '' ) return null;
    if ( in_array( $e, $list, true ) ) return 'email';
    $at = strrchr( $e, '@' );
    return ( $at && in_array( $at, $list, true ) ) ? 'domain' : null;
}

/** GET / POST /security/trusted-admins { emails: [...] } - the trusted administrator emails. */
function claude_security_trusted_admins( $req ) {
    if ( $req->get_method() === 'POST' ) {
        update_option( 'claude_trusted_admins', claude_trusted_clean( $req->get_param( 'emails' ) ), false );
    }
    return new WP_REST_Response( array( 'emails' => claude_trusted_admins() ) );
}

/**
 * A folder outside wp-content, read-only: each entry with its size and date,
 * and whether it is part of WordPress - so planted files with random names can
 * be found, not only the ones the scan flagged.
 */
function claude_security_list_dir( $real, $sums ) {
    $root  = wp_normalize_path( realpath( ABSPATH ) );
    $rel   = ltrim( substr( wp_normalize_path( $real ), strlen( $root ) ), '/' );
    $pre   = $rel === '' ? '' : $rel . '/';
    $dirs  = array();
    foreach ( array_keys( $sums ) as $f ) {
        for ( $d = dirname( $f ); $d !== '.' && $d !== ''; $d = dirname( $d ) ) $dirs[ $d ] = true;
    }
    $items = array();
    foreach ( (array) @scandir( $real ) as $name ) { // phpcs:ignore
        if ( $name === '.' || $name === '..' || $name === false ) continue;
        $path   = $pre . $name;
        $abs    = $real . '/' . $name;
        $is_dir = is_dir( $abs );
        $item   = array(
            'name'     => $name . ( $is_dir ? '/' : '' ),
            'type'     => $is_dir ? 'folder' : 'file',
            'modified' => wp_date( 'Y-m-d H:i', (int) @filemtime( $abs ) ), // phpcs:ignore
        );
        if ( ! $is_dir ) $item['size'] = (int) @filesize( $abs ); // phpcs:ignore
        if ( $path === 'wp-content' ) {
            $item['note'] = 'use the file tools';
        } elseif ( $is_dir ) {
            $item['wordpress'] = isset( $dirs[ $path ] );
        } else {
            $item['wordpress'] = isset( $sums[ $path ] );
            $wf = claude_security_wordfence_waf( $abs );
            if ( $wf === true ) $item['known'] = 'Wordfence firewall loader (genuine)';
            elseif ( $wf === false ) $item['warning'] = 'named like Wordfence\'s firewall loader, but its content is not Wordfence\'s';
            if ( wp_normalize_path( $abs ) === claude_security_prepend_file() ) $item['loaded_before_every_request'] = true;
            if ( ! $item['wordpress'] && $wf !== true && preg_match( '/\.(php\d?|phtml|phar|inc|ico)$/i', $name ) && ! in_array( $path, array( 'wp-config.php' ), true ) ) $item['suspicious'] = true;
        }
        $items[] = $item;
        if ( count( $items ) >= 2000 ) break;
    }
    usort( $items, function ( $a, $b ) { return strcmp( $a['type'], $b['type'] ) ?: strcasecmp( $a['name'], $b['name'] ); } );
    $odd = array_values( array_filter( $items, function ( $i ) { return isset( $i['wordpress'] ) && ! $i['wordpress']; } ) );
    return new WP_REST_Response( array(
        'path'          => $rel === '' ? '(site root)' : $rel,
        'items'         => $items,
        'not_wordpress' => count( $odd ),
        'note'          => 'Read-only listing. "wordpress": false means the path is not part of WordPress ' . get_bloginfo( 'version' ) . ' - in wp-admin and wp-includes that is always worth a look; in the site root, config, verification and host files are normal. Open a file by passing its path; move planted files out with POST /security/quarantine {"paths": [...]}.',
    ) );
}

/** Patterns that are rare in honest code and common in malware. */
function claude_security_patterns() {
    return array(
        'eval_decode'   => array( 'eval() of decoded data', '/\beval\s*\(\s*(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|rawurldecode|hex2bin)\s*\(/i' ),
        'decode_blob'   => array( 'large encoded blob decoded at runtime', '/(?:base64_decode|gzinflate|gzuncompress|str_rot13)\s*\(\s*[\'"][A-Za-z0-9+\/=\\\\]{300,}/' ),
        'request_exec'  => array( 'runs code or commands from the request', '/\b(?:eval|assert|system|shell_exec|passthru|exec|popen|proc_open)\s*\(\s*(?:@?\$_(?:POST|GET|REQUEST|COOKIE|SERVER)|stripslashes\s*\(\s*\$_)/i' ),
        'hex_obfusc'    => array( 'heavily hex-escaped code', '/(?:\\\\x[0-9a-f]{2}){40,}/i' ),
        'preg_e'        => array( 'preg_replace with the /e modifier', '/preg_replace\s*\(\s*[\'"][^\'"]*\/[a-z]*e[a-z]*[\'"]\s*,/i' ),
        'create_func'   => array( 'create_function() (common in old backdoors)', '/\bcreate_function\s*\(/i' ),
        'shell_names'   => array( 'known web-shell names', '/\b(?:FilesMan|WSOsetcookie|b374k|r57shell|c99shell|Shell_Wso|IndoXploit|alfa-shell|wp_vcd)\b/i' ),
        'include_image' => array( 'includes an image file as PHP', '/\b(?:include|require)(?:_once)?\s*\(?\s*[\'"][^\'"]+\.(?:ico|png|jpe?g|gif|svg)[\'"]/i' ),
        'upload_shell'  => array( 'saves uploaded files without checks', '/move_uploaded_file\s*\(\s*\$_FILES/i' ),
        'var_func'      => array( 'calls a function named by request data', '/\$_(?:POST|GET|REQUEST|COOKIE)\s*\[[^\]]+\]\s*\(/i' ),
    );
}

/**
 * Scans one file's content against the patterns. Returns the first few hits
 * with their line numbers and a short snippet.
 */
function claude_security_scan_file( $path, $patterns ) {
    $size = @filesize( $path ); // phpcs:ignore
    if ( ! $size || $size > 2 * MB_IN_BYTES ) return array();
    $code = @file_get_contents( $path ); // phpcs:ignore
    if ( $code === false ) return array();
    $hits = array();
    foreach ( $patterns as $id => list( $label, $re ) ) {
        if ( preg_match( $re, $code, $m, PREG_OFFSET_CAPTURE ) ) {
            $line    = substr_count( substr( $code, 0, $m[0][1] ), "\n" ) + 1;
            $snippet = substr( $code, max( 0, $m[0][1] - 40 ), 160 );
            $hits[]  = array( 'pattern' => $id, 'label' => $label, 'line' => $line, 'snippet' => preg_replace( '/\s+/', ' ', $snippet ) );
        }
        if ( count( $hits ) >= 3 ) break;
    }
    return $hits;
}

/** PHP-ish files under a folder, skipping dependency folders. Bounded. */
function claude_security_php_files( $dir, $limit, $deadline ) {
    $out = array();
    if ( ! is_dir( $dir ) ) return $out;
    try {
        $it = new RecursiveIteratorIterator(
            new RecursiveCallbackFilterIterator(
                new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
                function ( $f ) {
                    return ! ( $f->isDir() && in_array( $f->getFilename(), array( 'node_modules', '.git', 'cache', 'claude-rollback', 'upgrade-temp-backup' ), true ) );
                }
            )
        );
        foreach ( $it as $f ) {
            if ( count( $out ) >= $limit || microtime( true ) > $deadline ) break;
            if ( $f->isFile() && preg_match( '/\.(?:php\d?|phtml|phar|inc)$/i', $f->getFilename() ) ) $out[] = $f->getPathname();
        }
    } catch ( \Throwable $e ) {}
    return $out;
}

function claude_security_rel( $path ) {
    return ltrim( str_replace( wp_normalize_path( ABSPATH ), '', wp_normalize_path( $path ) ), '/' );
}

function claude_security_scan( $req = null ) {
    require_once ABSPATH . 'wp-admin/includes/admin.php';
    @set_time_limit( 180 ); // phpcs:ignore
    $started  = microtime( true );
    $deadline = $started + 90;
    $findings = array();
    $add      = function ( $severity, $category, $title, $items = array(), $note = null ) use ( &$findings ) {
        $findings[] = array( 'severity' => $severity, 'category' => $category, 'title' => $title, 'note' => $note, 'count' => count( $items ), 'items' => array_slice( $items, 0, 40 ) );
    };
    $patterns   = claude_security_patterns();
    $clean      = array(); // files that match published checksums: not pattern-scanned
    $wp_version = get_bloginfo( 'version' );

    // 1. Active plugins whose files are gone - WordPress then deactivates them with
    //    "Plugin file does not exist". Also what was recently deactivated.
    $missing = array();
    foreach ( (array) get_option( 'active_plugins', array() ) as $p ) {
        if ( ! file_exists( WP_PLUGIN_DIR . '/' . $p ) ) $missing[] = array( 'path' => "wp-content/plugins/{$p}" );
    }
    if ( $missing ) $add( 'high', 'plugins', 'Active plugins whose files are missing', $missing, 'Deleted outside WordPress - by malware, a malware cleaner, or a failed update.' );
    $recent = array();
    foreach ( (array) get_option( 'recently_activated', array() ) as $p => $when ) {
        $recent[] = array( 'path' => "wp-content/plugins/{$p}", 'detail' => 'deactivated ' . wp_date( 'Y-m-d H:i', (int) $when ) . ( file_exists( WP_PLUGIN_DIR . '/' . $p ) ? '' : ' - files missing' ) );
    }
    if ( $recent ) $add( 'info', 'plugins', 'Recently deactivated plugins', $recent );

    // 1b. Plugins that hide themselves. The Plugins screen and `wp plugin list` both
    //     show get_plugins() after the all_plugins filter; a plugin removed by that
    //     filter is on disk but invisible - how SEO-spam backdoors survive.
    $all_plugins = get_plugins();
    $listed      = apply_filters( 'all_plugins', $all_plugins );
    $hidden      = array();
    foreach ( array_diff_key( $all_plugins, is_array( $listed ) ? $listed : array() ) as $file => $data ) {
        $hidden[] = array( 'path' => "wp-content/plugins/{$file}", 'detail' => trim( "{$data['Name']} {$data['Version']}" ) . ( $data['Author'] ? '' : ', no author' ) . ( is_plugin_active( $file ) ? ' - ACTIVE' : '' ) . ' - hidden from the Plugins screen and WP-CLI' );
    }
    if ( $hidden ) $add( 'high', 'plugins', 'Plugins hidden from the Plugins screen', $hidden, 'A plugin that removes itself from the plugin list is how SEO-spam backdoors such as "WP Link Helper" survive. A few white-label tools hide plugins on purpose - check what each one is before acting. Hidden plugins often reinstall themselves: look for must-use plugins and settings with random names too.' );

    // 2. WordPress core against wordpress.org's checksums.
    $sums = get_core_checksums( $wp_version, get_locale() ) ?: get_core_checksums( $wp_version, 'en_US' );
    if ( is_array( $sums ) && $sums ) {
        $modified = $missing_core = array();
        foreach ( $sums as $file => $md5 ) {
            if ( strpos( $file, 'wp-content/' ) === 0 ) continue; // bundled themes/plugins may be removed
            $abs = ABSPATH . $file;
            if ( ! file_exists( $abs ) ) { $missing_core[] = array( 'path' => $file ); continue; }
            if ( md5_file( $abs ) !== $md5 ) $modified[] = array( 'path' => $file );
            elseif ( preg_match( '/\.php$/', $file ) ) $clean[ wp_normalize_path( $abs ) ] = true;
        }
        if ( $modified ) $add( 'high', 'core', 'WordPress core files that differ from wordpress.org', $modified, 'Core files are never edited by plugins - a changed one usually means an injection. Restore them by reinstalling the same WordPress version.' );
        if ( $missing_core ) $add( 'medium', 'core', 'WordPress core files that are missing', $missing_core );
        // Files in wp-admin / wp-includes that are not part of WordPress.
        $known = array_flip( array_map( 'wp_normalize_path', array_keys( $sums ) ) );
        $extra = array();
        foreach ( array( 'wp-admin', 'wp-includes' ) as $dir ) {
            foreach ( claude_security_php_files( ABSPATH . $dir, 20000, $deadline ) as $f ) {
                $rel = claude_security_rel( $f );
                if ( ! isset( $known[ $rel ] ) ) $extra[] = array( 'path' => $rel, 'detail' => 'modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ) );
            }
        }
        if ( $extra ) $add( 'high', 'core', 'PHP files in wp-admin / wp-includes that are not part of WordPress', $extra, 'A favourite hiding place for backdoors.' );
        // Unexpected PHP files next to wp-config.php.
        $root = $fake = array();
        foreach ( (array) glob( ABSPATH . '*.php' ) as $f ) {
            $rel = claude_security_rel( $f );
            if ( isset( $known[ $rel ] ) || in_array( $rel, array( 'wp-config.php', 'wp-config-sample.php' ), true ) ) continue;
            $wf = claude_security_wordfence_waf( $f );
            if ( $wf === true ) continue; // Wordfence's firewall loader
            if ( $wf === false ) { $fake[] = array( 'path' => $rel, 'detail' => 'modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ) . ' - named like Wordfence\'s firewall loader, but the content is not Wordfence\'s' ); continue; }
            $root[] = array( 'path' => $rel, 'detail' => 'modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ) );
        }
        if ( $fake ) $add( 'high', 'core', 'A file posing as Wordfence\'s firewall loader', $fake, 'Genuine wordfence-waf.php only includes wp-content/plugins/wordfence/waf/bootstrap.php. Malware borrows the name because people trust it. It may be loaded before every request (auto_prepend_file in .user.ini), so check that before removing it.' );
        if ( $root ) $add( 'medium', 'core', 'Extra PHP files in the site root', $root, 'Some are legitimate (host or cache tools); unknown ones are worth opening.' );
    } else {
        $add( 'info', 'core', 'Could not fetch WordPress checksums - core files were not compared', array(), "WordPress {$wp_version} / " . get_locale() );
    }

    // 3. wordpress.org plugins against their published checksums.
    $updates  = get_site_transient( 'update_plugins' );
    $modified = $unknown = array();
    $checked  = $asked = 0;
    foreach ( get_plugins() as $file => $data ) {
        if ( microtime( true ) > $deadline - 30 ) break;
        if ( dirname( $file ) === '.' ) continue;
        $info = $updates->response[ $file ] ?? $updates->no_update[ $file ] ?? null;
        // Known not to be from wordpress.org (premium, custom): skip. Unknown (empty
        // update cache): ask - the checksum service answers 404 for anything else.
        if ( $info && ! empty( $info->id ) && strpos( (string) $info->id, 'w.org/plugins/' ) !== 0 ) continue;
        if ( ++$asked > 60 ) break;
        $slug = dirname( $file );
        $r    = wp_remote_get( "https://downloads.wordpress.org/plugin-checksums/{$slug}/{$data['Version']}.json", array( 'timeout' => 8 ) );
        if ( is_wp_error( $r ) || wp_remote_retrieve_response_code( $r ) !== 200 ) continue;
        $files = json_decode( wp_remote_retrieve_body( $r ), true )['files'] ?? null;
        if ( ! is_array( $files ) ) continue;
        $checked++;
        $base = WP_PLUGIN_DIR . '/' . $slug . '/';
        foreach ( $files as $rel => $h ) {
            $abs = $base . $rel;
            if ( ! file_exists( $abs ) ) continue;
            $md5s = (array) ( $h['md5'] ?? array() );
            if ( ! in_array( md5_file( $abs ), $md5s, true ) ) { if ( preg_match( '/\.php$/i', $rel ) ) $modified[] = array( 'path' => "wp-content/plugins/{$slug}/{$rel}" ); }
            else $clean[ wp_normalize_path( $abs ) ] = true;
        }
        foreach ( claude_security_php_files( $base, 5000, $deadline ) as $f ) {
            $rel = substr( wp_normalize_path( $f ), strlen( wp_normalize_path( $base ) ) );
            if ( ! isset( $files[ $rel ] ) ) $unknown[] = array( 'path' => "wp-content/plugins/{$slug}/{$rel}" );
        }
    }
    if ( $modified ) $add( 'high', 'plugins', 'wordpress.org plugin files that differ from the published version', $modified );
    if ( $unknown ) $add( 'medium', 'plugins', 'PHP files inside wordpress.org plugins that the published version does not have', $unknown, 'Some plugins write cache or config PHP files; anything else is suspicious.' );

    // 4. PHP in uploads - never needed there.
    $uploads = wp_upload_dir()['basedir'];
    $in_up   = array();
    foreach ( claude_security_php_files( $uploads, 500, $deadline ) as $f ) {
        if ( basename( $f ) === 'index.php' && filesize( $f ) < 100 ) continue; // "silence is golden"
        $in_up[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ), 'hits' => claude_security_scan_file( $f, $patterns ) );
    }
    if ( $in_up ) $add( 'high', 'files', 'PHP files in the uploads folder', $in_up, 'Uploads should only hold media; PHP there is a classic backdoor.' );

    // 4b. PHP in places WordPress never puts it - loose in the plugins folder (not a
    //     plugin), in languages (WordPress's own translations are *.l10n.php), in
    //     cgi-bin - and empty PHP files, which is what a malware cleaner leaves after
    //     emptying a backdoor (their dates show when the site was infected). Caches
    //     legitimately hold PHP, so only empty files or malware matches count there.
    $odd = $empty = array();
    $note_file = function ( $f, $why ) use ( &$odd, &$empty, $patterns ) {
        $size = (int) @filesize( $f ); // phpcs:ignore
        $item = array( 'path' => claude_security_rel( $f ), 'detail' => "{$why}, modified " . wp_date( 'Y-m-d H:i', filemtime( $f ) ) );
        if ( $size === 0 ) { $empty[] = $item; return; }
        $item['hits'] = claude_security_scan_file( $f, $patterns );
        $odd[] = $item;
    };
    foreach ( (array) glob( WP_PLUGIN_DIR . '/*.php' ) as $f ) {
        $b = basename( $f );
        if ( $b === 'index.php' || isset( $all_plugins[ $b ] ) ) continue;
        $note_file( $f, 'loose file in the plugins folder that is not a plugin' );
    }
    foreach ( claude_security_php_files( WP_CONTENT_DIR . '/languages', 3000, $deadline ) as $f ) {
        if ( preg_match( '/\.l10n\.php$/', $f ) || ( basename( $f ) === 'index.php' && filesize( $f ) < 100 ) ) continue;
        $note_file( $f, 'PHP in the languages folder' );
    }
    foreach ( claude_security_php_files( ABSPATH . 'cgi-bin', 500, $deadline ) as $f ) {
        $note_file( $f, 'PHP in cgi-bin' );
    }
    foreach ( claude_security_php_files( WP_CONTENT_DIR . '/cache', 5000, $deadline ) as $f ) {
        if ( (int) @filesize( $f ) === 0 ) { $empty[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'empty, in a cache folder, modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ) ); continue; } // phpcs:ignore
        $h = claude_security_scan_file( $f, $patterns );
        if ( $h ) $odd[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'in a cache folder, modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ), 'hits' => $h );
    }
    foreach ( $in_up as $u ) {
        if ( (int) @filesize( ABSPATH . $u['path'] ) === 0 ) $empty[] = array( 'path' => $u['path'], 'detail' => 'empty, in uploads - ' . $u['detail'] ); // phpcs:ignore
    }
    if ( $odd ) $add( 'high', 'files', 'PHP files in places WordPress never puts them', $odd, 'Backdoors hide where nobody looks, with plausible names (cache-handler.php, translation-cache.php, plugin-loader.php).' );
    if ( $empty ) $add( 'low', 'files', 'Empty PHP files left behind', $empty, 'Usually backdoors a malware cleaner emptied instead of deleting. Harmless now - but files with the same dates elsewhere may still be live, and the dates tell the host when the site was broken into.' );

    // 5. Known malware patterns in themes, plugins, mu-plugins and drop-ins.
    $hits    = array();
    $scanned = 0;
    $self    = realpath( __FILE__ );
    $roots   = array( get_theme_root(), WP_PLUGIN_DIR, defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins' );
    foreach ( $roots as $dir ) {
        foreach ( claude_security_php_files( $dir, 40000, $deadline ) as $f ) {
            if ( isset( $clean[ wp_normalize_path( $f ) ] ) ) continue;
            if ( realpath( $f ) === $self ) continue; // this file names the patterns
            $scanned++;
            $h = claude_security_scan_file( $f, $patterns );
            if ( $h ) $hits[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ), 'hits' => $h );
        }
    }
    foreach ( (array) glob( WP_CONTENT_DIR . '/*.php' ) as $f ) {
        $scanned++;
        $h = claude_security_scan_file( $f, $patterns );
        if ( $h ) $hits[] = array( 'path' => claude_security_rel( $f ), 'hits' => $h );
    }
    if ( $hits ) $add( 'high', 'code', 'Code matching known malware patterns', $hits, 'Some premium plugins obfuscate their code legitimately - check each file before acting.' );

    // 6. What runs before everything else: mu-plugins and drop-ins.
    $early = array();
    foreach ( (array) glob( ( defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins' ) . '/*.php' ) as $f ) {
        $early[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'must-use plugin, modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ) );
    }
    $dropins = array_keys( _get_dropins() );
    foreach ( (array) glob( WP_CONTENT_DIR . '/*.php' ) as $f ) {
        $name = basename( $f );
        if ( $name === 'index.php' ) continue;
        $early[] = array( 'path' => claude_security_rel( $f ), 'detail' => in_array( $name, $dropins, true ) ? 'WordPress drop-in' : 'not a known WordPress drop-in' );
    }
    if ( $early ) $add( 'info', 'files', 'Code that loads before plugins (mu-plugins and drop-ins)', $early, 'Usually from hosts and cache plugins; anything you do not recognise deserves a look.' );
    $random_mu = array();
    foreach ( (array) glob( ( defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins' ) . '/*.php' ) as $f ) {
        if ( ! preg_match( '/^(?:wp-)?[0-9a-f]{10,}\.php$/i', basename( $f ) ) ) continue;
        $name = get_file_data( $f, array( 'name' => 'Plugin Name' ) )['name'];
        $random_mu[] = array( 'path' => claude_security_rel( $f ), 'detail' => ( $name ? "\"{$name}\"" : 'no plugin name' ) . ', modified ' . wp_date( 'Y-m-d H:i', filemtime( $f ) ), 'hits' => claude_security_scan_file( $f, $patterns ) );
    }
    if ( $random_mu ) $add( 'high', 'files', 'Must-use plugins with random names', $random_mu, 'Must-use plugins load on every request and cannot be switched off in wp-admin. A random hex name is typical of the copies a backdoor uses to reinstall itself.' );
    global $wpdb;
    $random_opts = array();
    foreach ( (array) $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'wp\\_%' OR option_name LIKE 'wlh\\_%' LIMIT 5000" ) as $name ) { // phpcs:ignore
        if ( preg_match( '/^(?:wp_[0-9a-f]{20,}|wlh_.+)$/', $name ) ) $random_opts[] = array( 'path' => $name, 'detail' => 'setting with a random name' );
    }
    if ( $random_opts ) $add( 'medium', 'database', 'Settings with random names', $random_opts, 'Backdoors keep their (often encrypted) configuration in settings like these. Remove them only together with the code that uses them, or it recreates them.' );

    // 7. PHP files changed in the last 7 days outside core.
    $week   = time() - 7 * DAY_IN_SECONDS;
    $recent = array();
    foreach ( array_merge( $roots, array( $uploads ) ) as $dir ) {
        foreach ( claude_security_php_files( $dir, 40000, $deadline ) as $f ) {
            $t = @filemtime( $f ); // phpcs:ignore
            if ( $t && $t > $week ) $recent[] = array( 'path' => claude_security_rel( $f ), 'detail' => wp_date( 'Y-m-d H:i', $t ), 't' => $t );
        }
    }
    usort( $recent, function ( $a, $b ) { return $b['t'] - $a['t']; } );
    if ( $recent ) $add( 'low', 'files', 'PHP files changed in the last 7 days', array_map( function ( $r ) { unset( $r['t'] ); return $r; }, $recent ), 'Updates change files too - compare against what was updated.' );

    // 8a. The same username on several accounts. WordPress never allows that, so
    //     these rows were written straight into the database (malware, SQL injection).
    $dups = array();
    foreach ( (array) $wpdb->get_results( "SELECT user_login, COUNT(*) AS n, GROUP_CONCAT(ID) AS ids FROM {$wpdb->users} GROUP BY user_login HAVING COUNT(*) > 1 LIMIT 50" ) as $d ) { // phpcs:ignore
        $dups[] = array( 'path' => $d->user_login, 'detail' => "{$d->n} accounts with this username - user IDs {$d->ids}" );
    }
    if ( $dups ) $add( 'high', 'users', 'The same username on several accounts (inserted straight into the database)', $dups, 'WordPress never creates two accounts with one username - these rows were written into the database directly, typically by malware or an SQL injection, and are usually rogue administrators. Remove them by user ID, never by username (one name matches several), reassigning their content to a real administrator.' );

    // 8. Administrator accounts, with reasons any look out of place. With a
    //    trusted list (sent by the dashboard, else the site's own), an admin is
    //    judged by its email - the username is ignored - and any other admin is flagged.
    $tp      = $req instanceof WP_REST_Request ? $req->get_param( 'trusted' ) : null;
    $trusted = $tp !== null ? claude_trusted_clean( $tp ) : claude_trusted_admins();
    $site_domain = preg_replace( '/^www\./', '', strtolower( (string) parse_url( home_url(), PHP_URL_HOST ) ) );
    $admins = $suspicious = array();
    foreach ( get_users( array( 'role' => 'administrator', 'orderby' => 'registered', 'order' => 'DESC', 'number' => 100 ) ) as $u ) {
        $reasons = array();
        $reg     = strtotime( $u->user_registered );
        $new     = $reg > time() - 30 * DAY_IN_SECONDS;
        $trust   = $trusted ? claude_trusted_match( $u->user_email, $trusted ) : null;
        if ( trim( (string) $u->user_email ) === '' ) { $reasons[] = 'no email address (WordPress requires one - often added straight into the database)'; $trust = null; }
        if ( $trust === 'domain' ) {
            if ( $new ) $reasons[] = 'created in the last 30 days - trusted by its domain only, so check it is a real colleague';
        } elseif ( $trust !== 'email' ) {
            if ( $trusted ) $reasons[] = 'email is not on the trusted list';
            if ( $new ) $reasons[] = 'created in the last 30 days';
            if ( preg_match( '/^[a-f0-9]{10,}$/i', $u->user_login ) || preg_match( '/^[a-z]{2,}\d{3,}$/i', $u->user_login ) ) $reasons[] = 'username looks machine-generated';
            if ( preg_match( '/^(?:admin|administrator|wpadmin|support|root|test|user|backup|seo|manager)\d+$/i', $u->user_login ) ) $reasons[] = 'username is a common attacker pattern';
            $email_domain = strtolower( (string) substr( strrchr( (string) $u->user_email, '@' ), 1 ) );
            if ( ! $trusted && $email_domain && $site_domain && $email_domain !== $site_domain && strpos( $site_domain, $email_domain ) === false && ! in_array( $email_domain, array( 'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'bigpond.com' ), true ) ) $reasons[] = "email on another domain ({$email_domain})";
        }
        $entry = array(
            'path'       => $u->user_login,
            'id'         => (int) $u->ID,
            'email'      => strtolower( (string) $u->user_email ),
            'detail'     => '#' . $u->ID . ' · ' . ( $u->user_email ?: 'no email' ) . ' · registered ' . wp_date( 'Y-m-d', $reg ) . ' · ' . count_user_posts( $u->ID ) . ' posts · display "' . $u->display_name . '"' . ( $trust ? ' · trusted' . ( $trust === 'domain' ? ' (by domain)' : '' ) : '' ) . ( $reasons ? ' · ' . implode( '; ', $reasons ) : '' ),
            'trusted'    => $trust,
            'suspicious' => ! empty( $reasons ),
        );
        $admins[] = $entry;
        if ( $reasons ) $suspicious[] = $entry;
    }
    if ( $suspicious ) $add( 'medium', 'users', $trusted ? 'Administrator accounts not on the trusted list' : 'Administrator accounts that look out of place', $suspicious, $trusted ? 'These administrators\' emails are not on the trusted list. Check each with whoever manages the site; remove any not meant to be there, or add a genuine one to the trusted emails.' : 'Attackers add or rename an admin account to keep access. Check each with whoever manages the site; remove any not meant to be there. Tip: set trusted administrator emails, and every admin with another email is flagged.' );
    $add( 'info', 'users', 'All administrator accounts', $admins, $trusted ? count( $trusted ) . ' trusted email' . ( count( $trusted ) === 1 ? '' : 's' ) . '/domain' . ( count( $trusted ) === 1 ? '' : 's' ) . ' set.' : 'Review the full list - an attacker account can also look ordinary.' );

    // 9. .htaccess redirects and PHP settings that pull in other files.
    $ht = array();
    foreach ( array( ABSPATH . '.htaccess', $uploads . '/.htaccess', WP_CONTENT_DIR . '/.htaccess' ) as $f ) {
        if ( ! is_readable( $f ) ) continue;
        foreach ( preg_split( '/\R/', (string) file_get_contents( $f ) ) as $i => $line ) {
            $why = claude_htaccess_line_flag( $line );
            if ( $why ) $ht[] = array( 'path' => claude_security_rel( $f ), 'detail' => 'line ' . ( $i + 1 ) . ': ' . trim( substr( $line, 0, 200 ) ) . ' - ' . $why );
        }
    }
    if ( $ht ) $add( 'high', 'config', '.htaccess rules that redirect elsewhere or load extra PHP', $ht, 'Spam redirects (often only for search engines or mobile visitors) live here. For the site-root .htaccess: review it with GET /security/htaccess (MCP wp_htaccess_review) and restore WordPress\'s rules with POST /security/htaccess (wp_htaccess_restore) - a copy is kept and it reverts itself if the site breaks.' );

    // 10. wp-config.php: code that does not belong in a config file. Only matching
    //     lines are reported - never the database password or keys.
    $cfg = file_exists( ABSPATH . 'wp-config.php' ) ? ABSPATH . 'wp-config.php' : dirname( ABSPATH ) . '/wp-config.php';
    if ( is_readable( $cfg ) ) {
        $cfg_hits = array();
        foreach ( preg_split( '/\R/', (string) file_get_contents( $cfg ) ) as $i => $line ) {
            if ( preg_match( '/\b(?:eval|base64_decode|gzinflate|str_rot13)\s*\(|@include|include\s*\(?\s*[\'"][^\'"]+\.(?:ico|png|jpe?g|txt)/i', $line ) ) {
                $cfg_hits[] = array( 'path' => 'wp-config.php', 'detail' => 'line ' . ( $i + 1 ) . ': ' . trim( substr( $line, 0, 160 ) ) );
            }
        }
        if ( $cfg_hits ) $add( 'high', 'config', 'Suspicious code in wp-config.php', $cfg_hits );
    }

    // 11. Injected code in content - including inside page-builder modules (Divi
    //     Code modules, Elementor widgets), where it hides from a file scan. Reports
    //     the snippet and any outside domain, so a planted script in a Divi Code
    //     module is visible even though it lives in the database, not a file.
    global $wpdb;
    $home_host = strtolower( (string) parse_url( home_url(), PHP_URL_HOST ) );
    // Widget domains you trust (sent by the dashboard, else the site's own list).
    $th            = $req instanceof WP_REST_Request ? $req->get_param( 'trusted_hosts' ) : null;
    $trusted_hosts = $th !== null ? claude_trusted_hosts_clean( $th ) : claude_trusted_hosts();
    // Well-known widget, analytics, chat, booking and embed services, matched with
    // their subdomains (stats.wp.com, quiescence.au3.cliniko.com).
    $known_domains = array(
        'googletagmanager.com', 'google-analytics.com', 'googlesyndication.com', 'googleadservices.com', 'doubleclick.net', 'wp.com', 'gravatar.com',
        'licdn.com', 'linkedin.com', 'hotjar.com', 'clarity.ms', 'crazyegg.com', 'podium.com', 'fontawesome.com', 'cliniko.com', 'mailerlite.com',
        'acuityscheduling.com', 'calendly.com', 'typeform.com', 'jotform.com', 'tawk.to', 'tidio.co', 'intercom.io', 'intercomcdn.com', 'zdassets.com',
        'zendesk.com', 'livechatinc.com', 'pinterest.com', 'pinimg.com', 'tiktok.com', 'twitter.com', 'twimg.com', 'x.com', 'cloudflare.com',
        'recaptcha.net', 'hcaptcha.com', 'wistia.com', 'wistia.net', 'vidyard.com', 'loom.com', 'matterport.com', 'issuu.com', 'opentable.com',
        'opentable.com.au', 'resdiary.com', 'simplybook.me', 'fresha.com', 'mindbodyonline.com', 'addtoany.com', 'sharethis.com', 'microsoft.com',
        'squareup.com', 'paypal.com', 'paypalobjects.com', 'stripe.com', 'stripe.network', 'list-manage.com', 'credly.com', 'reviewability.com',
        'easyweddings.com.au', 'book-directonline.com', 'siteminder.com', 'tourmake.net', 'trustindex.io', 'elfsight.com', 'hubspot.com', 'hsforms.com',
    );

    $find_injection = function ( $text ) use ( $home_host, $trusted_hosts, $known_domains ) {
        if ( $text === '' || $text === null ) return null;
        $decoded = html_entity_decode( str_replace( array( '||et_pb_line_break_holder||', '%22', '%91', '%93' ), array( "\n", '"', '[', ']' ), $text ), ENT_QUOTES, 'UTF-8' );
        $ok = array(
            // analytics / tags / scripts
            'www.googletagmanager.com', 'www.google-analytics.com', 'www.gstatic.com', 'connect.facebook.net', 'platform.twitter.com', 'js.stripe.com', 'maps.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'code.jquery.com', 'unpkg.com', 'www.recaptcha.net', 'www.google.com/recaptcha', 'cdn.shopify.com', 'static.hotjar.com', 'embed.tawk.to', 'www.clarity.ms', 'maps.google.com', 'www.googleadservices.com', 'googleads.g.doubleclick.net',
            // embed iframes: maps, video, docs/forms, social, booking, audio
            'www.google.com', 'www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.vimeo.com', 'vimeo.com', 'www.openstreetmap.org', 'www.bing.com', 'docs.google.com', 'calendar.google.com', 'drive.google.com', 'www.facebook.com', 'web.facebook.com', 'www.instagram.com', 'open.spotify.com', 'w.soundcloud.com', 'bandcamp.com', 'airtable.com', 'calendly.com', 'www.jotform.com', 'form.jotform.com', 'app.acuityscheduling.com', 'www.tripadvisor.com', 'widget.trustpilot.com',
            // review / social-feed / form widgets commonly embedded via a Code module
            'cdn.trustindex.io', 'static.elfsight.com', 'apps.elfsight.com', 'core.service.elfsight.com', 'static.elfsightcdn.com', 'cdn.curator.io', 'widgets.sociablekit.com', 'embedsocial.com', 'cdn.embedsocial.com', 'www.powr.io', 'cdn.powr.io', 'widget.tagembed.com', 'cdn.tagembed.com', 'widget.reviews.io', 'widget.reviews.co.uk', 'cdn.reviews.io', 'www.birdeye.com', 'reviewsonmywebsite.com', 'static.cdn-website.com', 'www.mailchimp.com', 'chimpstatic.com', 'js.hsforms.net', 'js.hs-scripts.com', 'static.klaviyo.com', 'cdn.jsdelivr.net', 'www.instagram.com', 'snapwidget.com', 'cdn.lightwidget.com', 'lightwidget.com', 'embed.youtube.com', 'maps.googleapis.com', 'www.gstatic.com', 'consent.cookiebot.com', 'consentcdn.cookiebot.com', 'cdn.cookielaw.org'
        );
        // Known iframe-embed hosts (and regional variants) are not injections.
        $embed_ok = function ( $host ) use ( $ok, $trusted_hosts, $known_domains ) {
            if ( preg_match( '/^(?:storage|firebasestorage)\.googleapis\.com$/', $host ) ) return false; // anyone can host files there
            foreach ( array_merge( $trusted_hosts, $known_domains ) as $d ) {
                if ( $host === $d || substr( $host, -strlen( '.' . $d ) ) === '.' . $d ) return true;
            }
            return in_array( $host, $ok, true ) || preg_match( '/(^|\.)(google|googleapis|gstatic|youtube|youtube-nocookie|vimeo|facebook|fbcdn|instagram|cdninstagram|spotify|soundcloud|openstreetmap|bing|tripadvisor|trustpilot|trustindex|elfsight|elfsightcdn|curator|sociablekit|embedsocial|powr|tagembed|reviews|birdeye|snapwidget|lightwidget|cookiebot|cookielaw|hubspot|hs-scripts|hsforms|klaviyo|mailchimp|stripe|paypal|cloudflareinsights)\.[a-z.]+$/', $host );
        };
        foreach ( array( (string) $text, (string) $decoded ) as $hay ) {
            // EVERY <script src> and <iframe src> is checked, not just the first - a
            // single Divi Code module can hold a legitimate embed and a planted one.
            if ( preg_match_all( '#<script\b[^>]*\bsrc\s*=\s*["\']?(?:https?:)?//([^"\'\s>/]+)[^>]*>#i', $hay, $ms, PREG_SET_ORDER ) ) {
                foreach ( $ms as $m ) {
                    $host = strtolower( $m[1] );
                    if ( $host !== $home_host && strpos( $host, $home_host ) === false && ! $embed_ok( $host ) ) return array( 'why' => "external script from {$host}", 'host' => $host, 'snippet' => trim( substr( $m[0], 0, 180 ) ) );
                }
            }
            if ( preg_match_all( '#<iframe\b[^>]*\bsrc\s*=\s*["\']?(?:https?:)?//([^"\'\s>/]+)[^>]*>#i', $hay, $ms, PREG_SET_ORDER ) ) {
                foreach ( $ms as $m ) {
                    $fhost = strtolower( $m[1] );
                    if ( $fhost !== $home_host && strpos( $fhost, $home_host ) === false && ! $embed_ok( $fhost ) ) return array( 'why' => "iframe from {$fhost}", 'host' => $fhost, 'snippet' => trim( substr( $m[0], 0, 180 ) ) );
                }
            }
            if ( preg_match( '#(eval\s*\(\s*(?:atob|function|String\.fromCharCode)|String\.fromCharCode\s*\(|document\.write\s*\(\s*unescape|\batob\s*\(\s*["\']|(?:\\\\x[0-9a-f]{2}){8,}|base64_decode\s*\()#i', $hay, $m, PREG_OFFSET_CAPTURE ) ) {
                return array( 'why' => 'obfuscated or self-decoding script', 'snippet' => trim( substr( $hay, max( 0, $m[0][1] - 20 ), 180 ) ) );
            }
            // Inline script doing something an injection does: building a <script>
            // element, loading an external src, or redirecting the browser. (Plain
            // analytics/dataLayer code is left alone; obfuscation is caught above.)
            if ( preg_match( '#(createElement\s*\(\s*["\']script|document\.write\s*\([^)]*<(?:script|iframe)|\.src\s*=\s*["\']?(?:https?:)?//(?!(?:[^"\'\s/]*\.)?' . preg_quote( $home_host, '#' ) . ')|(?:window|top|self|document)\.location(?:\.href)?\s*=\s*["\'](?:https?:)?//(?!(?:[^"\'\s/]*\.)?' . preg_quote( $home_host, '#' ) . '))#i', $hay, $m, PREG_OFFSET_CAPTURE ) ) {
                return array( 'why' => 'inline script loads code or redirects elsewhere', 'snippet' => trim( preg_replace( '/\s+/', ' ', substr( $hay, max( 0, $m[0][1] - 10 ), 180 ) ) ) );
            }
            if ( preg_match( '#<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+url=([^"\'>]+)#i', $hay, $m ) ) {
                return array( 'why' => 'meta-refresh redirect', 'snippet' => trim( substr( $m[0], 0, 180 ) ) );
            }
        }
        return null;
    };

    $types = array_unique( array_merge( array_values( get_post_types( array( 'public' => true ) ) ), array( 'et_header_layout', 'et_body_layout', 'et_footer_layout', 'wp_block', 'wp_template', 'wp_template_part' ) ) );
    $in    = implode( ',', array_map( function ( $t ) use ( $wpdb ) { return $wpdb->prepare( '%s', $t ); }, $types ) );
    $rows  = $wpdb->get_results( "SELECT ID, post_title, post_type, post_content FROM {$wpdb->posts} WHERE post_status IN ('publish','draft','private','pending','future') AND post_type IN ({$in}) AND (post_content LIKE '%<script%' OR post_content LIKE '%<iframe%' OR post_content LIKE '%eval%' OR post_content LIKE '%fromCharCode%' OR post_content LIKE '%et_pb_code%' OR post_content LIKE '%base64%' OR post_content LIKE '%unescape%' OR post_content LIKE '%http-equiv%') LIMIT 300" ); // phpcs:ignore
    $hits = array();
    foreach ( (array) $rows as $r ) {
        $inj = $find_injection( (string) $r->post_content );
        if ( ! $inj ) continue;
        $builder = strpos( $r->post_content, 'et_pb_code' ) !== false ? ' (in a Divi Code module)' : ( strpos( $r->post_content, 'et_pb_' ) !== false ? ' (in Divi builder content)' : '' );
        $hits[] = array( 'path' => "{$r->post_type} #{$r->ID}: " . ( $r->post_title ?: '(no title)' ), 'detail' => $inj['why'] . $builder, 'host' => $inj['host'] ?? null, 'hits' => array( array( 'label' => $inj['why'], 'line' => 0, 'snippet' => preg_replace( '/\s+/', ' ', $inj['snippet'] ) ) ) );
        if ( count( $hits ) >= 50 ) break;
    }
    $meta = $wpdb->get_results( "SELECT post_id, meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_elementor_data' AND (meta_value LIKE '%<script%' OR meta_value LIKE '%fromCharCode%' OR meta_value LIKE '%eval(%' OR meta_value LIKE '%<iframe%' OR meta_value LIKE '%base64%') LIMIT 200" ); // phpcs:ignore
    foreach ( (array) $meta as $mm ) {
        $inj = $find_injection( (string) $mm->meta_value );
        if ( ! $inj ) continue;
        $hits[] = array( 'path' => 'post #' . $mm->post_id . ' (Elementor)', 'detail' => $inj['why'] . ' (in an Elementor widget)', 'host' => $inj['host'] ?? null, 'hits' => array( array( 'label' => $inj['why'], 'line' => 0, 'snippet' => preg_replace( '/\s+/', ' ', $inj['snippet'] ) ) ) );
        if ( count( $hits ) >= 70 ) break;
    }
    if ( $hits ) $add( 'high', 'content', 'Injected code in posts, pages or builder content', $hits, "Legitimate embeds (analytics, maps, forms, chat) come from known providers; a script or iframe from an unknown domain, or obfuscated code, is an injection - often hidden inside a Divi Code module or Elementor widget. Site host: {$home_host}." );

    $opts = $wpdb->get_results( "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name NOT LIKE '\_transient%' AND option_name NOT LIKE '\_site\_transient%' AND (option_value LIKE '%<script%' OR option_value LIKE '%fromCharCode%' OR option_value LIKE '%eval(%' OR option_value LIKE '%<iframe%') LIMIT 100" ); // phpcs:ignore
    $o_items = array();
    foreach ( (array) $opts as $o ) {
        $inj = $find_injection( (string) $o->option_value );
        if ( $inj ) $o_items[] = array( 'path' => $o->option_name, 'detail' => $inj['why'], 'host' => $inj['host'] ?? null, 'hits' => array( array( 'label' => $inj['why'], 'line' => 0, 'snippet' => preg_replace( '/\s+/', ' ', $inj['snippet'] ) ) ) );
    }
    if ( $o_items ) $add( 'high', 'content', 'Injected code in settings (wp_options)', $o_items, 'Header/footer-script and theme-option plugins store scripts here legitimately; an unknown external or obfuscated one is not.' );

    // 12. Site address, in case it was changed to send visitors elsewhere.
    $siteurl = get_option( 'siteurl' );
    $home    = get_option( 'home' );
    if ( parse_url( $siteurl, PHP_URL_HOST ) !== parse_url( $home, PHP_URL_HOST ) ) {
        $add( 'high', 'config', 'Site address and WordPress address point to different domains', array( array( 'path' => 'siteurl', 'detail' => $siteurl ), array( 'path' => 'home', 'detail' => $home ) ) );
    }

    $order = array( 'high' => 0, 'medium' => 1, 'low' => 2, 'info' => 3 );
    usort( $findings, function ( $a, $b ) use ( $order ) { return $order[ $a['severity'] ] - $order[ $b['severity'] ]; } );
    $count = function ( $sev ) use ( $findings ) { return count( array_filter( $findings, function ( $f ) use ( $sev ) { return $f['severity'] === $sev; } ) ); };

    return new WP_REST_Response( array(
        'scanned_at' => gmdate( 'c' ),
        'site'       => home_url( '/' ),
        'wp_version' => $wp_version,
        'summary'    => array( 'high' => $count( 'high' ), 'medium' => $count( 'medium' ), 'low' => $count( 'low' ) ),
        'stats'      => array( 'php_files_pattern_scanned' => $scanned, 'wporg_plugins_verified' => $checked, 'seconds' => round( microtime( true ) - $started, 1 ), 'stopped_early' => microtime( true ) > $deadline ),
        'findings'   => $findings,
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Divi contact form email patterns
//
//  Divi only puts the fields listed in a form's Message Pattern into the email
//  it sends; a field missing from it, or a placeholder whose ID does not match
//  a field (%%Service%% for a field with ID "services"), is silently dropped.
//  Divi 4 stores the pattern in the contact form shortcode's custom_message
//  attribute, with line breaks as ||et_pb_line_break_holder||.
// ──────────────────────────────────────────────────────────────────────────────

const CLAUDE_DIVI_LINE_BREAK = '||et_pb_line_break_holder||';

/** Attributes of one shortcode tag, as Divi writes them (name="value"). */
function claude_divi_attrs( $tag ) {
    preg_match_all( '/([\w-]+)="([^"]*)"/', $tag, $m, PREG_SET_ORDER );
    $out = array();
    foreach ( $m as $a ) $out[ $a[1] ] = $a[2];
    return $out;
}

/** Divi 4 attribute encoding <-> plain text. */
function claude_divi_decode( $v ) {
    return strtr( str_replace( CLAUDE_DIVI_LINE_BREAK, "\n", $v ), array( '%22' => '"', '%91' => '[', '%93' => ']' ) );
}
function claude_divi_encode( $v ) {
    $v = str_replace( array( "\r\n", "\r" ), "\n", (string) $v );
    return str_replace( "\n", CLAUDE_DIVI_LINE_BREAK, strtr( $v, array( '"' => '%22', '[' => '%91', ']' => '%93' ) ) );
}

/**
 * The Divi 4 contact forms in a piece of content, in order: their tag's
 * position (to rewrite it), attributes, fields and pattern problems.
 */
function claude_divi_parse_forms( $content ) {
    $forms = array();
    if ( ! preg_match_all( '/\[et_pb_contact_form\b[^\]]*\](.*?)\[\/et_pb_contact_form\]/s', $content, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE ) ) return $forms;
    foreach ( $m as $i => $hit ) {
        $open = substr( $hit[0][0], 0, strpos( $hit[0][0], ']' ) + 1 );
        $a    = claude_divi_attrs( $open );
        $fields = array();
        preg_match_all( '/\[et_pb_contact_field\b[^\]]*\]/', $hit[1][0], $fm );
        foreach ( $fm[0] as $ft ) {
            $fa = claude_divi_attrs( $ft );
            if ( empty( $fa['field_id'] ) ) continue;
            $fields[] = array( 'id' => $fa['field_id'], 'title' => claude_divi_decode( $fa['field_title'] ?? $fa['field_id'] ), 'type' => $fa['field_type'] ?? 'input' );
        }
        $pattern = isset( $a['custom_message'] ) ? claude_divi_decode( $a['custom_message'] ) : '';
        preg_match_all( '/%%([^%\s]+)%%/', $pattern, $pm );
        $used   = array_unique( $pm[1] );
        $ids    = array_column( $fields, 'id' );
        $forms[] = array(
            'index'      => $i,
            'offset'     => $hit[0][1],
            'open_tag'   => $open,
            'title'      => claude_divi_decode( $a['title'] ?? '' ),
            'recipient'  => $a['email'] ?? '',
            'fields'     => $fields,
            'pattern'    => $pattern,
            // Placeholders are matched exactly (the field ID as written).
            'missing'    => array_values( array_diff( $ids, $used ) ),
            'unknown'    => array_values( array_diff( $used, $ids ) ),
            'suggested'  => claude_divi_suggest_pattern( $fields ),
        );
    }
    return $forms;
}

/**
 * "Name: %%Name%%" per field, labelled from the field ID (Full_Name -> "Full Name");
 * text areas as "Message:" with the value on the next line.
 */
function claude_divi_suggest_pattern( $fields ) {
    $lines = array();
    foreach ( $fields as $f ) {
        $label   = ucwords( trim( preg_replace( '/[_\-]+/', ' ', $f['id'] ) ) ) ?: $f['title'];
        $lines[] = $f['type'] === 'text' ? "{$label}:\n%%{$f['id']}%%" : "{$label}: %%{$f['id']}%%";
    }
    return implode( "\n", $lines );
}

/** GET /divi/forms - every Divi 4 contact form on the site and its pattern problems. */
function claude_divi_forms() {
    global $wpdb;
    $rows = $wpdb->get_results( "SELECT ID, post_title, post_type, post_content FROM {$wpdb->posts} WHERE post_status IN ('publish','private','draft') AND post_type NOT IN ('revision','nav_menu_item') AND (post_content LIKE '%[et\\_pb\\_contact\\_form%' OR post_content LIKE '%wp:divi/contact-form%') LIMIT 200" ); // phpcs:ignore
    $out  = array();
    $divi5 = array();
    foreach ( (array) $rows as $r ) {
        $layout = in_array( $r->post_type, array( 'et_header_layout', 'et_body_layout', 'et_footer_layout' ), true );
        foreach ( claude_divi_parse_forms( $r->post_content ) as $f ) {
            unset( $f['offset'], $f['open_tag'] );
            $out[] = array_merge( array(
                'post_id' => (int) $r->ID,
                'post'    => $r->post_title ?: "#{$r->ID}",
                'where'   => $layout ? 'Theme Builder ' . str_replace( array( 'et_', '_layout' ), '', $r->post_type ) : $r->post_type,
                'url'     => $layout ? home_url( '/' ) : get_permalink( $r->ID ),
            ), $f, array( 'ok' => $f['pattern'] !== '' && ! $f['missing'] && ! $f['unknown'] ) );
        }
        if ( strpos( $r->post_content, 'wp:divi/contact-form' ) !== false ) $divi5[] = array( 'post_id' => (int) $r->ID, 'post' => $r->post_title, 'url' => get_permalink( $r->ID ) );
    }
    return new WP_REST_Response( array( 'forms' => $out, 'divi5' => $divi5 ) );
}

/**
 * POST /divi/forms/pattern { post_id, index, pattern } - sets one form's Message
 * Pattern. The previous pattern is kept in an option for undo.
 */
function claude_divi_set_pattern( $req ) {
    $post_id = (int) $req->get_param( 'post_id' );
    $index   = (int) $req->get_param( 'index' );
    $pattern = trim( (string) $req->get_param( 'pattern' ) );
    $post    = get_post( $post_id );
    if ( ! $post ) return new WP_Error( 'not_found', "No post #{$post_id}.", array( 'status' => 404 ) );
    if ( $pattern === '' ) return new WP_Error( 'missing', 'pattern is empty.', array( 'status' => 400 ) );
    $forms = claude_divi_parse_forms( $post->post_content );
    if ( ! isset( $forms[ $index ] ) ) return new WP_Error( 'not_found', "Post #{$post_id} has no Divi contact form #{$index}.", array( 'status' => 404 ) );
    $f = $forms[ $index ];

    $encoded = claude_divi_encode( $pattern );
    $tag     = preg_match( '/\scustom_message="[^"]*"/', $f['open_tag'] )
        ? preg_replace( '/\scustom_message="[^"]*"/', ' custom_message="' . $encoded . '"', $f['open_tag'], 1 )
        : preg_replace( '/^\[et_pb_contact_form\b/', '[et_pb_contact_form custom_message="' . $encoded . '"', $f['open_tag'], 1 );
    $content = substr_replace( $post->post_content, $tag, $f['offset'], strlen( $f['open_tag'] ) );

    $backup = (array) get_option( 'claude_divi_pattern_backup', array() );
    $backup[ "{$post_id}:{$index}" ] = array( 'pattern' => $f['pattern'], 'at' => gmdate( 'c' ) );
    update_option( 'claude_divi_pattern_backup', $backup, false );

    $r = wp_update_post( wp_slash( array( 'ID' => $post_id, 'post_content' => $content ) ), true );
    if ( is_wp_error( $r ) ) return $r;
    clean_post_cache( $post_id );
    $after = claude_divi_parse_forms( get_post( $post_id )->post_content )[ $index ] ?? null;
    return new WP_REST_Response( array(
        'post_id'  => $post_id,
        'index'    => $index,
        'previous' => $f['pattern'],
        'pattern'  => $after['pattern'] ?? null,
        'missing'  => $after['missing'] ?? null,
        'unknown'  => $after['unknown'] ?? null,
    ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Files  (hard-bounded to WP_CONTENT_DIR)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a user-supplied path to an absolute path, ensuring it stays within
 * WP_CONTENT_DIR. Returns false if any path traversal escapes the boundary.
 *
 * @param  string $relative
 * @return string|false
 */
function claude_safe_path( $relative ) {
    $base   = realpath( WP_CONTENT_DIR );
    $target = WP_CONTENT_DIR . DIRECTORY_SEPARATOR . ltrim( $relative, '/\\' );

    $resolved = realpath( $target );
    if ( $resolved !== false ) {
        // Path exists - verify it's inside the boundary.
        return ( $resolved === $base || str_starts_with( $resolved, $base . DIRECTORY_SEPARATOR ) )
            ? $resolved : false;
    }

    // Path doesn't exist yet. realpath() can't normalise the part that doesn't
    // exist, so refuse any ".." in the request outright, then check the nearest
    // ancestor that DOES exist is inside the boundary. (Checking only the direct
    // parent made new subfolders impossible - write/fetch/commit already
    // wp_mkdir_p() the parent, but never got that far.)
    $segments = preg_split( '#[\\\\/]+#', (string) $relative );
    if ( in_array( '..', $segments, true ) ) return false;

    $ancestor = dirname( $target );
    while ( ( $real = realpath( $ancestor ) ) === false ) {
        $next = dirname( $ancestor );
        if ( $next === $ancestor ) return false;
        $ancestor = $next;
    }
    return ( $real === $base || str_starts_with( $real, $base . DIRECTORY_SEPARATOR ) )
        ? $target : false;
}

/**
 * Syntax-checks PHP content before writing, in-process via the tokenizer.
 * Returns the error message on syntax failure, or null if clean (or not a PHP file).
 *
 * This used to shell out to `PHP_BINARY -l`, but under a web SAPI PHP_BINARY is
 * php-fpm / lsphp / empty, not the CLI: php-fpm rejects -l (every PHP write came
 * back as a "syntax error"), an empty name throws a ValueError on PHP 8 (HTTP
 * 500), and lsphp can hang until the request times out. TOKEN_PARSE runs the
 * real parser, so it catches the same parse errors without spawning anything.
 *
 * @param  string $content  File content to check.
 * @param  string $rel      Relative path (used to detect .php extension).
 * @return string|null
 */
function claude_php_lint( $content, $rel ) {
    if ( ! str_ends_with( strtolower( $rel ), '.php' ) ) {
        return null; // not a PHP file – skip
    }
    if ( ! function_exists( 'token_get_all' ) || ! defined( 'TOKEN_PARSE' ) ) {
        return null; // tokenizer extension missing – skip silently
    }
    try {
        token_get_all( (string) $content, TOKEN_PARSE );
    } catch ( \ParseError $e ) {
        return sprintf( 'PHP Parse error: %s in %s on line %d', $e->getMessage(), $rel, $e->getLine() );
    } catch ( \Throwable $e ) {
        return null; // anything else is the checker's problem, not the file's
    }
    return null;
}

/**
 * Builds the write_failed error with the reason, so a 500 on e.g. a child theme
 * says whether it was permissions rather than just "Could not write file."
 *
 * @param  string $abs_path  Absolute path that failed to write.
 * @param  string $rel       Relative path for the message.
 * @return WP_Error
 */
function claude_write_error( $abs_path, $rel ) {
    $dir = dirname( $abs_path );
    if ( ! is_dir( $dir ) ) {
        $why = 'directory could not be created';
    } elseif ( is_file( $abs_path ) && ! is_writable( $abs_path ) ) {
        $why = 'file is not writable by the web server user';
    } elseif ( ! is_file( $abs_path ) && ! is_writable( $dir ) ) {
        $why = 'directory is not writable by the web server user';
    } else {
        $last = error_get_last();
        $why  = $last ? $last['message'] : 'unknown reason';
    }
    return new WP_Error( 'write_failed', "Could not write {$rel}: {$why}.", array( 'status' => 500 ) );
}

/**
 * Creates a timestamped .bak copy of a file before overwriting it.
 * Silently skips if the file does not exist yet (new file) or copy fails.
 *
 * @param  string $abs_path  Absolute path to the file.
 * @return string|null       Path to the backup, or null if none was made.
 */
function claude_backup_file( $abs_path ) {
    if ( ! is_file( $abs_path ) ) {
        return null;
    }
    $backup = $abs_path . '.' . gmdate( 'YmdHis' ) . '.bak';
    return @copy( $abs_path, $backup ) ? $backup : null; // phpcs:ignore
}

/**
 * Loads the site the way WordPress's own theme/plugin file editor does after a
 * save, to find out whether the file just written white-screens it.
 *
 * Core's wp_start_scraping_edited_file_errors() (wp-settings.php) watches any
 * request carrying a valid wp_scrape_key/wp_scrape_nonce pair and, at shutdown,
 * prints the last fatal error (or `true`) between two marker lines. Checks the
 * dashboard and the homepage, so fatals in admin-only and front-end code both
 * count.
 *
 * @return array { status: ok|fatal|unverified, message?, url? }
 */
function claude_loopback_health( $extra_urls = array() ) {
    $key   = md5( wp_generate_password( 20, false ) );
    $nonce = wp_generate_password( 20, false );
    set_transient( 'scrape_key_' . $key, $nonce, 60 );

    $headers = array( 'Cache-Control' => 'no-cache' );
    // Sites behind HTTP basic auth: pass the same credentials through, as core does.
    if ( isset( $_SERVER['PHP_AUTH_USER'], $_SERVER['PHP_AUTH_PW'] ) ) {
        $headers['Authorization'] = 'Basic ' . base64_encode( wp_unslash( $_SERVER['PHP_AUTH_USER'] ) . ':' . wp_unslash( $_SERVER['PHP_AUTH_PW'] ) );
    }
    $args = array(
        'timeout'     => 30,
        // Logged out, /wp-admin/ redirects to wp-login.php and the scrape params end
        // up nested in redirect_to. The redirect response itself still ran all of
        // WordPress and carries the marker, so read that instead of following it.
        'redirection' => 0,
        'headers'     => $headers,
        'sslverify'   => apply_filters( 'https_local_ssl_verify', false ),
    );

    $start  = "###### wp_scraping_result_start:{$key} ######";
    $end    = "###### wp_scraping_result_end:{$key} ######";
    $result = array( 'status' => 'ok' );

    foreach ( array_merge( array( admin_url(), home_url( '/' ) ), (array) $extra_urls ) as $url ) {
        $r = wp_remote_get( add_query_arg( array( 'wp_scrape_key' => $key, 'wp_scrape_nonce' => $nonce ), $url ), $args );
        if ( is_wp_error( $r ) ) {
            $result = array( 'status' => 'unverified', 'url' => $url, 'message' => 'Could not load the site to check it: ' . $r->get_error_message() );
            continue;
        }
        $code = (int) wp_remote_retrieve_response_code( $r );
        $body = (string) wp_remote_retrieve_body( $r );
        $pos  = strpos( $body, $start );

        if ( $pos === false ) {
            if ( $code >= 500 ) {
                // Died before core could report, or a host error page replaced it.
                $result = array( 'status' => 'fatal', 'url' => $url, 'message' => "HTTP {$code} from {$url} with no error details." );
                break;
            }
            // Served without running WordPress, e.g. a page cache or a loopback block.
            $result = array( 'status' => 'unverified', 'url' => $url, 'message' => "HTTP {$code} from {$url} without WordPress's check marker (page cache or blocked loopback?)." );
            continue;
        }

        $json  = substr( $body, $pos + strlen( $start ) );
        $json  = substr( $json, 0, (int) strpos( $json, $end ) );
        $error = json_decode( trim( $json ), true );
        if ( $error === true ) continue;

        if ( is_array( $error ) && isset( $error['message'] ) && ! isset( $error['code'] ) ) {
            $where  = isset( $error['file'], $error['line'] ) ? " in {$error['file']} on line {$error['line']}" : '';
            $result = array( 'status' => 'fatal', 'url' => $url, 'message' => $error['message'] . $where );
            break;
        }
        // scrape_nonce_failure, or output we could not parse.
        $result = array( 'status' => 'unverified', 'url' => $url, 'message' => "Could not read WordPress's check result from {$url}." );
    }

    delete_transient( 'scrape_key_' . $key );
    return $result;
}

/**
 * Runs after a .php file has been written: loads the site and, if it now hits a
 * fatal error, puts the previous content back (or removes a newly created file).
 * A syntax check alone cannot catch fatals such as redeclaring a parent theme's
 * function or calling one that does not exist.
 *
 * When the site cannot be loaded to check (loopback blocked, page cache), the
 * write is kept and the response says it was unverified - rolling back there
 * would make PHP writes impossible on those hosts.
 *
 * @param  string      $path      Absolute path just written.
 * @param  string      $rel       Relative path for messages.
 * @param  string|null $previous  Content before the write; null if the file is new.
 * @return array|WP_Error|null    Health result for the response, WP_Error after a
 *                                rollback, or null for non-PHP files.
 */
function claude_verify_php_write( $path, $rel, $previous ) {
    if ( ! str_ends_with( strtolower( $rel ), '.php' ) ) {
        return null;
    }
    // wp_opcache_invalidate() is admin-only; REST requests do not load it.
    require_once ABSPATH . 'wp-admin/includes/file.php';
    // Without this the check could run the old, cached bytecode and pass.
    wp_opcache_invalidate( $path, true );

    $health = claude_loopback_health();
    if ( $health['status'] !== 'fatal' ) {
        return $health;
    }

    $restored = $previous === null ? @unlink( $path ) : @file_put_contents( $path, $previous ) !== false; // phpcs:ignore
    wp_opcache_invalidate( $path, true );

    if ( ! $restored ) {
        return new WP_Error(
            'rollback_failed',
            "Wrote {$rel}, the site hit a fatal error ({$health['message']}), and restoring the previous version FAILED. "
            . 'Restore it by hand (FTP / file manager) from the .bak copy next to it.',
            array( 'status' => 500, 'health' => $health )
        );
    }
    return new WP_Error(
        'php_fatal_rolled_back',
        "Not saved: {$rel} made the site fail with a fatal error, so the previous version was "
        . ( $previous === null ? 'restored (the new file was removed)' : 'restored' ) . ". Error: {$health['message']}",
        array( 'status' => 422, 'health' => $health )
    );
}

function claude_files_list( $req ) {
    $path = claude_safe_path( sanitize_text_field( (string) $req->get_param( 'path' ) ) );
    if ( ! $path )           return claude_outside_wp_content();
    if ( ! is_dir( $path ) ) return new WP_Error( 'not_dir',   'Path is not a directory.',      array( 'status' => 400 ) );
    $items = array();
    foreach ( scandir( $path ) as $entry ) {
        if ( $entry === '.' || $entry === '..' ) continue;
        $full    = $path . DIRECTORY_SEPARATOR . $entry;
        $items[] = array(
            'name'     => $entry,
            'type'     => is_dir( $full ) ? 'dir' : 'file',
            'size'     => is_file( $full ) ? filesize( $full ) : null,
            'modified' => filemtime( $full ),
            'path'     => ltrim( str_replace( WP_CONTENT_DIR, '', $full ), '/\\' ),
        );
    }
    return new WP_REST_Response( $items );
}

function claude_files_read( $req ) {
    $rel  = sanitize_text_field( (string) $req->get_param( 'path' ) );
    $path = claude_safe_path( $rel );
    if ( ! $path )            return claude_outside_wp_content();
    if ( ! is_file( $path ) ) return new WP_Error( 'not_found', 'File not found.',             array( 'status' => 404 ) );
    return new WP_REST_Response( array( 'path' => $rel, 'size' => filesize( $path ), 'content' => file_get_contents( $path ) ) ); // phpcs:ignore
}

function claude_files_write( $req ) {
    $body    = (array) $req->get_json_params();
    $rel     = (string) ( $body['path'] ?? '' );
    $content = $body['content'] ?? null;

    // Accept base64-encoded content - allows writing PHP files through WAFs that
    // block POST bodies containing raw PHP code patterns (e.g. Cloudflare managed rules).
    if ( $content === null && isset( $body['content_b64'] ) ) {
        $decoded = base64_decode( (string) $body['content_b64'], true );
        if ( $decoded === false ) {
            return new WP_Error( 'invalid_b64', 'content_b64 is not valid base64.', array( 'status' => 400 ) );
        }
        $content = $decoded;
    }

    if ( ! $rel || $content === null ) {
        return new WP_Error( 'missing', 'Body must include "path" and either "content" or "content_b64".', array( 'status' => 400 ) );
    }
    $path = claude_safe_path( $rel );
    if ( ! $path ) return claude_outside_wp_content();

    // PHP syntax check before write - prevents a bad edit from white-screening the site.
    $lint_error = claude_php_lint( $content, $rel );
    if ( $lint_error ) {
        return new WP_Error( 'php_syntax_error', $lint_error, array( 'status' => 422 ) );
    }

    wp_mkdir_p( dirname( $path ) );
    $previous = is_file( $path ) ? file_get_contents( $path ) : null; // phpcs:ignore
    $backup   = claude_backup_file( $path ); // backup before overwrite
    $bytes    = @file_put_contents( $path, $content ); // phpcs:ignore
    if ( $bytes === false ) return claude_write_error( $path, $rel );

    $health = claude_verify_php_write( $path, $rel, $previous );
    if ( is_wp_error( $health ) ) return $health;

    return new WP_REST_Response( array(
        'written' => $rel,
        'bytes'   => $bytes,
        'backup'  => $backup ? ltrim( str_replace( WP_CONTENT_DIR, '', $backup ), '/\\' ) : null,
        'health'  => $health,
    ) );
}

/**
 * POST /files/fetch
 *
 * Downloads a URL straight to a path inside wp-content, server-side.
 *
 * Without this, the only way to get a file onto the server is to send its bytes
 * as a tool parameter, which means every byte of generated content round-trips
 * through the model's context - twice, if it was generated locally. On a large
 * build that is the dominant cost and it scales linearly with page count.
 *
 * Body: { url, path, timeout?, max_bytes? }
 */
function claude_files_fetch( $req ) {
    $body = (array) $req->get_json_params();
    $url  = (string) ( $body['url']  ?? '' );
    $rel  = (string) ( $body['path'] ?? '' );

    if ( ! $url || ! $rel ) {
        return new WP_Error( 'missing', 'Body must include "url" and "path".', array( 'status' => 400 ) );
    }
    if ( ! wp_http_validate_url( $url ) ) {
        return new WP_Error( 'invalid_url', 'URL failed validation.', array( 'status' => 400 ) );
    }

    $path = claude_safe_path( $rel );
    if ( ! $path ) {
        return claude_outside_wp_content();
    }

    require_once ABSPATH . 'wp-admin/includes/file.php';

    $tmp = download_url( $url, (int) ( $body['timeout'] ?? 60 ) );
    if ( is_wp_error( $tmp ) ) return $tmp;

    $max = (int) ( $body['max_bytes'] ?? 20 * MB_IN_BYTES );
    if ( filesize( $tmp ) > $max ) {
        @unlink( $tmp ); // phpcs:ignore
        return new WP_Error(
            'too_large',
            sprintf( 'Downloaded %d bytes, which exceeds max_bytes (%d).', filesize( $tmp ), $max ),
            array( 'status' => 413 )
        );
    }

    // Same syntax guard as files_write, so a fetched PHP file cannot white-screen
    // the site either.
    $lint_error = claude_php_lint( (string) file_get_contents( $tmp ), $rel ); // phpcs:ignore
    if ( $lint_error ) {
        @unlink( $tmp ); // phpcs:ignore
        return new WP_Error( 'php_syntax_error', $lint_error, array( 'status' => 422 ) );
    }

    wp_mkdir_p( dirname( $path ) );
    $previous = is_file( $path ) ? file_get_contents( $path ) : null; // phpcs:ignore
    $backup   = claude_backup_file( $path );

    // rename() fails across filesystem boundaries on some hosts; fall back to copy.
    if ( ! @rename( $tmp, $path ) ) { // phpcs:ignore
        if ( ! @copy( $tmp, $path ) ) { // phpcs:ignore
            @unlink( $tmp ); // phpcs:ignore
            return claude_write_error( $path, $rel );
        }
        @unlink( $tmp ); // phpcs:ignore
    }

    $health = claude_verify_php_write( $path, $rel, $previous );
    if ( is_wp_error( $health ) ) return $health;

    return new WP_REST_Response( array(
        'written' => $rel,
        'source'  => $url,
        'bytes'   => filesize( $path ),
        // Lets the caller verify the transfer without spending context reading it back.
        'sha256'  => hash_file( 'sha256', $path ),
        'backup'  => $backup ? ltrim( str_replace( WP_CONTENT_DIR, '', $backup ), '/\\' ) : null,
        'health'  => $health,
    ) );
}

/**
 * Stage one chunk of base64-encoded file content as a transient.
 * Chunk the file on the client side when the plain POST is blocked by a WAF.
 * Call /files/commit once all chunks are staged.
 */
function claude_files_stage( $req ) {
    $body        = (array) $req->get_json_params();
    $rel         = (string) ( $body['path']        ?? '' );
    $content_b64 = (string) ( $body['content_b64'] ?? '' );
    $chunk_index = (int)    ( $body['chunk_index']  ?? 0 );
    $chunk_total = (int)    ( $body['chunk_total']  ?? 1 );

    if ( ! $rel || ! $content_b64 ) {
        return new WP_Error( 'missing', 'Body must include "path" and "content_b64".', array( 'status' => 400 ) );
    }
    if ( $chunk_total < 1 || $chunk_total > 200 ) {
        return new WP_Error( 'invalid', 'chunk_total must be between 1 and 200.', array( 'status' => 400 ) );
    }
    if ( $chunk_index < 0 || $chunk_index >= $chunk_total ) {
        return new WP_Error( 'invalid', 'chunk_index must be 0 .. chunk_total-1.', array( 'status' => 400 ) );
    }

    $path = claude_safe_path( $rel );
    if ( ! $path ) return claude_outside_wp_content();

    $key = 'claude_stage_' . md5( $rel ) . '_' . $chunk_index;
    set_transient( $key, $content_b64, HOUR_IN_SECONDS );

    return new WP_REST_Response( array(
        'staged'      => true,
        'path'        => $rel,
        'chunk_index' => $chunk_index,
        'chunk_total' => $chunk_total,
    ) );
}

/**
 * Reassemble all staged chunks for a path and write the file to disk.
 * Transients are deleted after a successful commit.
 */
function claude_files_commit( $req ) {
    $body        = (array) $req->get_json_params();
    $rel         = (string) ( $body['path']       ?? '' );
    $chunk_total = (int)    ( $body['chunk_total'] ?? 1 );

    if ( ! $rel ) {
        return new WP_Error( 'missing', 'Body must include "path".', array( 'status' => 400 ) );
    }

    $path = claude_safe_path( $rel );
    if ( ! $path ) return claude_outside_wp_content();

    $content_b64 = '';
    for ( $i = 0; $i < $chunk_total; $i++ ) {
        $key   = 'claude_stage_' . md5( $rel ) . '_' . $i;
        $chunk = get_transient( $key );
        if ( $chunk === false ) {
            return new WP_Error(
                'missing_chunk',
                "Chunk {$i} not found. Stage all {$chunk_total} chunks before committing.",
                array( 'status' => 400 )
            );
        }
        $content_b64 .= $chunk;
    }

    $content = base64_decode( $content_b64, true );
    if ( $content === false ) {
        return new WP_Error( 'invalid_b64', 'Staged content is not valid base64.', array( 'status' => 500 ) );
    }

    // PHP syntax check before committing assembled chunks.
    $lint_error = claude_php_lint( $content, $rel );
    if ( $lint_error ) {
        // Clean up staged chunks so they don't linger.
        for ( $i = 0; $i < $chunk_total; $i++ ) {
            delete_transient( 'claude_stage_' . md5( $rel ) . '_' . $i );
        }
        return new WP_Error( 'php_syntax_error', $lint_error, array( 'status' => 422 ) );
    }

    wp_mkdir_p( dirname( $path ) );
    $previous = is_file( $path ) ? file_get_contents( $path ) : null; // phpcs:ignore
    $backup   = claude_backup_file( $path ); // backup before overwrite
    $bytes    = @file_put_contents( $path, $content ); // phpcs:ignore
    if ( $bytes === false ) {
        return claude_write_error( $path, $rel );
    }

    for ( $i = 0; $i < $chunk_total; $i++ ) {
        delete_transient( 'claude_stage_' . md5( $rel ) . '_' . $i );
    }

    $health = claude_verify_php_write( $path, $rel, $previous );
    if ( is_wp_error( $health ) ) return $health;

    return new WP_REST_Response( array(
        'written' => $rel,
        'bytes'   => $bytes,
        'backup'  => $backup ? ltrim( str_replace( WP_CONTENT_DIR, '', $backup ), '/\\' ) : null,
        'health'  => $health,
    ) );
}

function claude_files_delete( $req ) {
    $rel  = sanitize_text_field( (string) $req->get_param( 'path' ) );
    $path = claude_safe_path( $rel );
    if ( ! $path )              return claude_outside_wp_content();
    if ( ! file_exists( $path ) ) return new WP_Error( 'not_found', 'File not found.',           array( 'status' => 404 ) );
    $ok = is_dir( $path ) ? rmdir( $path ) : unlink( $path );
    if ( ! $ok ) return new WP_Error( 'delete_failed', 'Could not delete.', array( 'status' => 500 ) );
    return new WP_REST_Response( array( 'deleted' => $rel ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Database
// ──────────────────────────────────────────────────────────────────────────────

function claude_db_tables() {
    global $wpdb;
    return new WP_REST_Response( array( 'tables' => $wpdb->get_col( 'SHOW TABLES' ), 'prefix' => $wpdb->prefix ) );
}

function claude_db_query( $req ) {
    global $wpdb;
    $body     = (array) $req->get_json_params();
    $query    = $body['query'] ?? null;
    $type     = strtolower( (string) ( $body['type'] ?? 'get_results' ) );
    $readonly = ! empty( $body['readonly'] );

    if ( ! $query ) return new WP_Error( 'missing', 'Body must include "query".', array( 'status' => 400 ) );

    // readonly mode: block anything that isn't a plain SELECT.
    if ( $readonly && ! preg_match( '/^\s*SELECT\s/i', (string) $query ) ) {
        return new WP_Error( 'readonly', 'Only SELECT queries are allowed in readonly mode.', array( 'status' => 403 ) );
    }

    // Warn if the query looks destructive (DROP / TRUNCATE / DELETE without WHERE).
    $destructive = preg_match( '/^\s*(DROP|TRUNCATE)\s/i', (string) $query )
        || ( preg_match( '/^\s*DELETE\s/i', (string) $query ) && ! preg_match( '/\bWHERE\b/i', (string) $query ) );
    if ( $destructive && empty( $body['confirm_destructive'] ) ) {
        return new WP_Error(
            'destructive_query',
            'This query looks destructive (DROP / TRUNCATE / DELETE without WHERE). Pass "confirm_destructive": true to proceed.',
            array( 'status' => 400 )
        );
    }

    $allowed = array( 'get_results', 'get_row', 'get_var', 'get_col', 'query' );
    if ( ! in_array( $type, $allowed, true ) ) {
        return new WP_Error( 'invalid_type', 'type must be one of: ' . implode( ', ', $allowed ), array( 'status' => 400 ) );
    }

    // Bound parameters. Builder content is JSON inside post_content, so the
    // column literally contains \" - matching that by hand through a JSON tool
    // envelope needs three levels of backslash escaping, and getting it wrong
    // silently matches nothing. %s / %d / %f placeholders remove that entirely.
    if ( ! empty( $body['params'] ) && is_array( $body['params'] ) ) {
        $query = $wpdb->prepare( $query, $body['params'] ); // phpcs:ignore
        if ( ! $query ) {
            return new WP_Error(
                'prepare_failed',
                'Could not bind params. Check that the number of %s/%d/%f placeholders matches the params array.',
                array( 'status' => 400 )
            );
        }
    }

    // Rehearsal mode for write statements: run it, report what it would change,
    // then roll back. InnoDB only.
    $dry_run = ! empty( $body['dry_run'] ) && 'query' === $type;
    if ( $dry_run ) {
        $wpdb->query( 'START TRANSACTION' ); // phpcs:ignore
    }

    // Replaced PHP 8.0 match() with switch for PHP 7.4 compatibility.
    switch ( $type ) {
        case 'get_row':     $result = $wpdb->get_row( $query, ARRAY_A ); break;  // phpcs:ignore
        case 'get_var':     $result = $wpdb->get_var( $query );          break;  // phpcs:ignore
        case 'get_col':     $result = $wpdb->get_col( $query );          break;  // phpcs:ignore
        case 'query':       $result = $wpdb->query( $query );            break;  // phpcs:ignore
        default:            $result = $wpdb->get_results( $query, ARRAY_A );     // phpcs:ignore
    }

    // MySQL's affected-rows count for an UPDATE reports rows actually CHANGED,
    // not rows matched, so a statement that found its row but altered nothing
    // returns 0 - indistinguishable from a statement that matched nothing.
    // mysqli_info() reports both: "Rows matched: 1  Changed: 0  Warnings: 0".
    $matched = null;
    $changed = null;
    if ( 'query' === $type && isset( $wpdb->dbh ) && $wpdb->dbh instanceof mysqli ) {
        $info = (string) mysqli_info( $wpdb->dbh );
        if ( preg_match( '/Rows matched: (\d+)/', $info, $m ) ) {
            $matched = (int) $m[1];
        }
        if ( preg_match( '/Changed: (\d+)/', $info, $m ) ) {
            $changed = (int) $m[1];
        }
    }

    if ( $dry_run ) {
        $wpdb->query( 'ROLLBACK' ); // phpcs:ignore
    }

    if ( $wpdb->last_error ) return new WP_Error( 'db_error', $wpdb->last_error, array( 'status' => 500 ) );

    $response = array(
        'result'     => $result,
        'rows'       => is_array( $result ) ? count( $result ) : null,
        'last_query' => $wpdb->last_query,
    );

    if ( 'query' === $type ) {
        $response['affected_rows'] = is_int( $result ) ? $result : null;
        $response['matched_rows']  = $matched;
        $response['changed_rows']  = $changed;
        $response['insert_id']     = $wpdb->insert_id ?: null;
        if ( $dry_run ) {
            $response['dry_run']     = true;
            $response['rolled_back'] = true;
        }
        // The case worth shouting about: the WHERE clause found rows but the
        // statement altered none of them. For a REPLACE() that means the search
        // string was never present - usually an escaping mistake.
        if ( 0 === $changed && $matched > 0 ) {
            $response['warning'] = 'Matched ' . $matched . ' row(s) but changed none. '
                . 'If this was a REPLACE(), the search string did not appear in them - '
                . 'check your escaping, or use params with %s placeholders.';
        }
    }

    return new WP_REST_Response( $response );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Access Log
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Write one log row. Prunes the table to 1 000 rows after every 50 inserts
 * (checked via a lightweight counter transient) to prevent unbounded growth.
 */
function claude_log_access( $request, $response ) {
    global $wpdb;

    $ip     = claude_get_request_ip();
    $status = is_a( $response, 'WP_REST_Response' ) ? $response->get_status() : 500;

    $wpdb->insert(
        $wpdb->prefix . 'claude_log',
        array(
            'time'     => current_time( 'mysql', true ), // UTC
            'ip'       => $ip,
            'method'   => $request->get_method(),
            'endpoint' => $request->get_route(),
            'status'   => $status,
        ),
        array( '%s', '%s', '%s', '%s', '%d' )
    );

    // Prune: keep newest 1 000 entries (checked every ~50 writes via transient).
    $counter = (int) get_transient( 'claude_log_counter' );
    $counter++;
    set_transient( 'claude_log_counter', $counter, DAY_IN_SECONDS );
    if ( $counter % 50 === 0 ) {
        $table = $wpdb->prefix . 'claude_log';
        $count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" );
        if ( $count > 1000 ) {
            $wpdb->query( $wpdb->prepare( "DELETE FROM {$table} ORDER BY id ASC LIMIT %d", $count - 1000 ) );
        }
    }
}

function claude_logs_list( $req ) {
    global $wpdb;
    $limit = min( (int) ( $req->get_param( 'limit' ) ?: 50 ), 500 );
    $table = $wpdb->prefix . 'claude_log';
    $rows  = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$table} ORDER BY id DESC LIMIT %d", $limit ), ARRAY_A );
    return new WP_REST_Response( array( 'logs' => $rows, 'count' => count( $rows ) ) );
}

function claude_logs_clear() {
    global $wpdb;
    $wpdb->query( "TRUNCATE TABLE {$wpdb->prefix}claude_log" );
    return new WP_REST_Response( array( 'cleared' => true ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Internal REST dispatcher (shared by admin-ajax bridge and future transports)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Dispatches a command through the existing REST API stack using
 * rest_do_request() - no HTTP round-trip, no firewall involvement.
 *
 * @param  array $command  { method, endpoint, params, body, id }
 * @return array           { status, body }
 */
function claude_relay_execute( $command ) {
    $method   = strtoupper( sanitize_text_field( $command['method']   ?? 'GET' ) );
    $endpoint = sanitize_text_field( $command['endpoint'] ?? '/status' );
    $params   = is_array( $command['params'] ?? null ) ? $command['params'] : array();
    $body     = $command['body'] ?? null;

    $request = new WP_REST_Request( $method, '/' . CLAUDE_CONNECTOR_NS . $endpoint );
    $request->set_header( 'X-Claude-Key', claude_get_api_key() );

    if ( ! empty( $params ) ) {
        $request->set_query_params( $params );
    }
    if ( $body !== null ) {
        $request->set_body( wp_json_encode( $body ) );
        $request->set_header( 'Content-Type', 'application/json' );
    }

    $response = rest_do_request( $request );

    return array(
        'status' => $response->get_status(),
        'body'   => $response->get_data(),
    );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Admin-AJAX bridge  (Cloudflare WAF bypass - uses /wp-admin/admin-ajax.php
//  instead of /wp-json/, which Cloudflare's managed rules target specifically)
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'wp_ajax_claude_cmd',        'claude_ajax_handler' );
add_action( 'wp_ajax_nopriv_claude_cmd', 'claude_ajax_handler' );

/**
 * Handles POST /wp-admin/admin-ajax.php?action=claude_cmd.
 * Authenticates via X-Claude-Key header only (header-only, not $_REQUEST,
 * so a cookie named "_key" can never satisfy this check), then dispatches
 * the command internally using claude_relay_execute() - no second HTTP
 * request, no Cloudflare/Imunify involvement after this point.
 */
function claude_ajax_handler() {
    $provided = trim( (string) ( $_SERVER['HTTP_X_CLAUDE_KEY'] ?? '' ) );
    if ( ! $provided || ! hash_equals( claude_get_api_key(), $provided ) ) {
        wp_send_json( array( 'status' => 401, 'body' => array( 'error' => 'Unauthorized' ) ) );
        return;
    }
    $raw  = (string) file_get_contents( 'php://input' ); // phpcs:ignore
    $data = $raw ? (array) json_decode( $raw, true ) : array();
    wp_send_json( claude_relay_execute( array(
        'method'   => $data['method']   ?? 'GET',
        'endpoint' => $data['endpoint'] ?? '/status',
        'params'   => $data['params']   ?? array(),
        'body'     => $data['body']     ?? null,
        'id'       => 'ajax',
    ) ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Encrypted mode  (AES-256-GCM payload — bypasses body-inspection WAFs)
//
//  How it works:
//    1. The MCP server encrypts the command JSON with AES-256-GCM using a key
//       derived from the site's API key (SHA-256 hash of the key → 32 bytes).
//    2. The ciphertext is sent as a base64-encoded blob to admin-ajax.php.
//    3. WordPress decrypts it here and dispatches internally — the WAF only
//       ever sees random-looking base64, with no PHP code, SQL, or JSON
//       patterns to trigger ModSecurity / Imunify360 rules.
//
//  This is the recommended mode for sites where Imunify360 or aggressive
//  ModSecurity rulesets block even the Admin-AJAX mode.  No external server
//  or Cloudflare account is needed — everything runs on your local PC.
//
//  Wire format (all fields base64url-safe after outer base64 encode):
//    Bytes  0-11  : IV / nonce (12 bytes, random per request)
//    Bytes 12-end : AES-256-GCM ciphertext + 16-byte auth tag appended
//                   (matches WebCrypto SubtleCrypto AES-GCM output layout)
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'wp_ajax_claude_enc',        'claude_enc_handler' );
add_action( 'wp_ajax_nopriv_claude_enc', 'claude_enc_handler' );

/**
 * Decrypts an AES-256-GCM base64 payload using a 32-byte key derived from
 * the site's API key (SHA-256).
 *
 * @param  string $ciphertext_b64  Base64-encoded IV + ciphertext + GCM tag.
 * @param  string $api_key         Site API key (64-char hex).
 * @return string|false            Decrypted plaintext, or false on failure.
 */
function claude_decrypt_payload( $ciphertext_b64, $api_key ) {
    if ( ! function_exists( 'openssl_decrypt' ) ) {
        return false;
    }
    $raw = base64_decode( $ciphertext_b64, true );
    // Minimum: 12 (IV) + 16 (GCM tag) + 1 (data) = 29 bytes
    if ( $raw === false || strlen( $raw ) < 29 ) {
        return false;
    }
    $iv         = substr( $raw, 0, 12 );
    // WebCrypto appends the 16-byte GCM tag to the ciphertext; split it off.
    $ciphertext = substr( $raw, 12, -16 );
    $tag        = substr( $raw, -16 );
    $aes_key    = hash( 'sha256', $api_key, true ); // 32 raw bytes
    return openssl_decrypt( $ciphertext, 'aes-256-gcm', $aes_key, OPENSSL_RAW_DATA, $iv, $tag );
}

/**
 * Handles POST /wp-admin/admin-ajax.php?action=claude_enc.
 *
 * The request body is a JSON object: { "enc": "<base64 ciphertext>" }
 * No X-Claude-Key header is needed — the correct API key is *implicit* in
 * the ability to encrypt a payload that decrypts successfully.
 */
function claude_enc_handler() {
    $raw  = (string) file_get_contents( 'php://input' ); // phpcs:ignore
    $data = $raw ? json_decode( $raw, true ) : null;

    if ( ! is_array( $data ) || empty( $data['enc'] ) ) {
        wp_send_json( array( 'status' => 400, 'body' => array( 'error' => 'Invalid request: expected {"enc":"<base64>"}.' ) ) );
        return;
    }

    $plain = claude_decrypt_payload( (string) $data['enc'], claude_get_api_key() );
    if ( $plain === false ) {
        // Wrong key or tampered payload — return the same generic error as a bad key.
        wp_send_json( array( 'status' => 401, 'body' => array( 'error' => 'Decryption failed. Check your API key and mode.' ) ) );
        return;
    }

    $command = json_decode( $plain, true );
    if ( ! is_array( $command ) ) {
        wp_send_json( array( 'status' => 400, 'body' => array( 'error' => 'Decrypted payload is not valid JSON.' ) ) );
        return;
    }

    wp_send_json( claude_relay_execute( $command ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  WP-CLI
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Locate the wp binary. Checks the user-configured path first, then common
 * locations, then falls back to a PATH lookup via shell_exec/exec.
 *
 * @return string|null  Absolute path or null if not found.
 */
function claude_find_wpcli() {
    $custom = get_option( 'claude_wpcli_path', '' );
    if ( $custom && @is_executable( $custom ) ) {
        return $custom;
    }

    $candidates = array(
        '/usr/local/bin/wp',
        '/usr/bin/wp',
        '/opt/wp-cli/wp',
        '/root/.local/bin/wp',
        ABSPATH . 'wp-cli.phar',
        WP_CONTENT_DIR . '/../wp-cli.phar',
    );
    foreach ( $candidates as $c ) {
        if ( @is_executable( $c ) ) return $c;
    }

    foreach ( array( 'shell_exec', 'exec' ) as $fn ) {
        if ( function_exists( $fn ) ) {
            $found = trim( (string) @$fn( 'which wp 2>/dev/null' ) );
            if ( $found && @is_executable( $found ) ) return $found;
            break;
        }
    }

    return null;
}

/**
 * Execute a WP-CLI command and return stdout, stderr, and exit code.
 * Uses proc_open() (preferred) or exec() as fallback.
 *
 * @param  string[] $args  CLI args - do NOT include "wp" itself.
 * @return array           { exit_code, stdout, stderr, command }
 */
function claude_wpcli_run( array $args ) {
    $wp_bin = claude_find_wpcli();
    if ( ! $wp_bin ) {
        return array(
            'exit_code' => - 1,
            'stdout'    => '',
            'stderr'    => 'WP-CLI binary not found. Install it or set a custom path in WP Admin → Settings → Claude Connector.',
            'command'   => '',
        );
    }

    $cmd = array_merge( array( $wp_bin, '--path=' . rtrim( ABSPATH, '/' ), '--no-color' ), $args );

    // Docker/root environments need --allow-root
    if ( function_exists( 'posix_getuid' ) && posix_getuid() === 0 ) {
        $cmd[] = '--allow-root';
    }

    $command_str = implode( ' ', array_map( 'escapeshellarg', $cmd ) );

    $env = array(
        'HOME' => WP_CONTENT_DIR . '/uploads',
        'PATH' => '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    if ( ! empty( $_SERVER['USER'] ) ) {
        $env['USER'] = $_SERVER['USER'];
    }

    if ( function_exists( 'proc_open' ) ) {
        $descriptors = array(
            0 => array( 'pipe', 'r' ),
            1 => array( 'pipe', 'w' ),
            2 => array( 'pipe', 'w' ),
        );
        // Array $cmd bypasses shell (PHP 7.4+), preventing any injection.
        $proc = proc_open( $cmd, $descriptors, $pipes, ABSPATH, $env );
        if ( ! is_resource( $proc ) ) {
            return array( 'exit_code' => - 1, 'stdout' => '', 'stderr' => 'proc_open() failed to start process.', 'command' => $command_str );
        }
        fclose( $pipes[0] );
        $stdout    = (string) stream_get_contents( $pipes[1] );
        $stderr    = (string) stream_get_contents( $pipes[2] );
        fclose( $pipes[1] );
        fclose( $pipes[2] );
        $exit_code = proc_close( $proc );
        return array( 'exit_code' => $exit_code, 'stdout' => $stdout, 'stderr' => $stderr, 'command' => $command_str );
    }

    if ( function_exists( 'exec' ) ) {
        $output    = array();
        $exit_code = 0;
        exec( $command_str . ' 2>&1', $output, $exit_code ); // phpcs:ignore
        return array( 'exit_code' => $exit_code, 'stdout' => implode( "\n", $output ), 'stderr' => '', 'command' => $command_str );
    }

    return array(
        'exit_code' => - 1,
        'stdout'    => '',
        'stderr'    => 'proc_open() and exec() are both disabled on this server. Contact your host to enable one of them.',
        'command'   => $command_str,
    );
}

function claude_wpcli( $req ) {
    $body = (array) $req->get_json_params();
    $args = null;

    if ( isset( $body['args'] ) && is_array( $body['args'] ) ) {
        $args = array_values( array_map( 'strval', $body['args'] ) );
    } elseif ( isset( $body['command'] ) ) {
        // Strip optional leading "wp " prefix, then tokenise respecting quotes.
        $cmd = preg_replace( '/^wp\s+/i', '', trim( (string) $body['command'] ) );
        preg_match_all( '/\'[^\']*\'|"[^"]*"|\S+/', $cmd, $m );
        $args = array_values( array_map( function ( $a ) {
            return preg_replace( '/^([\'"])(.*)\1$/s', '$2', $a );
        }, $m[0] ) );
    }

    if ( empty( $args ) ) {
        return new WP_Error( 'missing', 'Body must include "args" (array) or "command" (string).', array( 'status' => 400 ) );
    }

    // Block dangerous or interactive sub-commands.
    // - shell / server  : interactive, hang forever.
    // - eval / eval-file : arbitrary PHP execution — use the REST API instead.
    // - package         : installs untrusted WP-CLI packages from the internet.
    // To run any of these locally, use your own terminal.
    $blocked_top = array( 'shell', 'server', 'eval', 'eval-file', 'package' );
    $cleanup = ' For malware cleanup use the security tools instead: GET /security/scan, list folders and read files outside wp-content with GET /security/core-file?path= (MCP wp_site_files), move planted files out with POST /security/quarantine (wp_quarantine_file), restore core with POST /security/reinstall-core (wp_reinstall_core).';
    if ( in_array( strtolower( $args[0] ), $blocked_top, true ) ) {
        return new WP_Error( 'blocked', "wp {$args[0]} is not allowed via this endpoint." . ( in_array( strtolower( $args[0] ), array( 'eval', 'eval-file' ), true ) ? $cleanup : '' ), array( 'status' => 400 ) );
    }

    // Block dangerous sub-command + sub-subcommand combinations.
    $blocked_sub = array(
        'db'   => array( 'import' ), // could import a malicious SQL dump
        'core' => array( 'download', 'update' ), // overwrites core files; do this intentionally via WP admin
    );
    $top = strtolower( $args[0] );
    $sub = isset( $args[1] ) ? strtolower( $args[1] ) : '';
    if ( isset( $blocked_sub[ $top ] ) && in_array( $sub, $blocked_sub[ $top ], true ) ) {
        $instead = $top === 'core' ? ' To restore the core files of the installed version use POST /security/reinstall-core (MCP wp_reinstall_core); WordPress updates run through the maintenance endpoints.' : '';
        return new WP_Error( 'blocked', "wp {$top} {$sub} is not allowed via this endpoint.{$instead}", array( 'status' => 400 ) );
    }

    $out = claude_wpcli_run( $args );
    if ( $top === 'core' && $sub === 'verify-checksums' && preg_match( '/should not exist|doesn\'t verify|File doesn/i', $out['stdout'] . $out['stderr'] ) ) {
        $out['hint'] = 'Files that "should not exist" are not part of WordPress: read one with GET /security/core-file?path= (MCP wp_site_files), and with the user\'s agreement move them out of the site with POST /security/quarantine {"paths": [...]} (wp_quarantine_file) - reversible. Files that don\'t verify or are missing: POST /security/reinstall-core (wp_reinstall_core).';
    }
    return new WP_REST_Response( $out );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Connect Script - downloadable one-click setup for Mac or Windows
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'wp_ajax_claude_connect_script', 'claude_connect_script_download' );

function claude_connect_script_download() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Unauthorized', '', array( 'response' => 403 ) );
    check_ajax_referer( 'claude_connect_script' );

    $os   = sanitize_key( $_GET['os'] ?? 'mac' ) === 'windows' ? 'windows' : 'mac';
    $site = claude_script_site();

    // Mac: a browser saves a bare .command without its execute bit ("you do not have the
    // privileges"). Inside a zip the bit survives unzipping, leaving only Gatekeeper's
    // one-time "Open Anyway". Hosts without ZipArchive get the bare file.
    if ( $os === 'mac' && class_exists( 'ZipArchive' ) ) {
        require_once ABSPATH . 'wp-admin/includes/file.php'; // wp_tempnam()
        $name = 'connect-' . $site['slug'] . '.command';
        $tmp  = wp_tempnam( 'claude-connect' );
        $zip  = new ZipArchive();
        if ( $tmp && $zip->open( $tmp, ZipArchive::OVERWRITE ) === true ) {
            $zip->addFromString( $name, claude_script_for( 'mac', $site ) );
            $zip->setExternalAttributesName( $name, ZipArchive::OPSYS_UNIX, ( 0100755 & 0xFFFF ) << 16 );
            $zip->close();
            header( 'Content-Type: application/zip' );
            header( 'Content-Disposition: attachment; filename="connect-' . $site['slug'] . '.zip"' );
            header( 'Content-Length: ' . filesize( $tmp ) );
            header( 'X-Content-Type-Options: nosniff' );
            readfile( $tmp );
            @unlink( $tmp ); // phpcs:ignore - holds the API key
            exit;
        }
        if ( $tmp ) @unlink( $tmp ); // phpcs:ignore
    }

    header( 'Content-Type: application/octet-stream' );
    header( 'Content-Disposition: attachment; filename="connect-' . $site['slug'] . ( $os === 'windows' ? '.ps1' : '.command' ) . '"' );
    header( 'X-Content-Type-Options: nosniff' );
    echo claude_script_for( $os, $site );
    exit;
}

/** Site details every setup script is built from. */
function claude_script_site() {
    $url  = rtrim( get_site_url(), '/' );
    $host = (string) parse_url( $url, PHP_URL_HOST );
    $host = preg_replace( '/^www\./', '', $host );
    $slug = strtolower( explode( '.', $host )[0] );
    $slug = preg_replace( '/[^a-z0-9]+/', '-', $slug );
    return array( 'url' => $url, 'key' => claude_get_api_key(), 'slug' => $slug, 'name' => ucfirst( str_replace( '-', ' ', $slug ) ) );
}

function claude_script_for( $os, $site ) {
    return $os === 'windows'
        ? claude_script_windows( $site['url'], $site['key'], $site['slug'], $site['name'] )
        : claude_script_mac( $site['url'], $site['key'], $site['slug'], $site['name'] );
}

// ── Mac setup by pasted command ───────────────────────────────────────────────
//
// A .command downloaded through a browser arrives without the execute bit ("you do
// not have the privileges", needs chmod +x) and quarantined, so Gatekeeper blocks
// it until approved in System Settings. A command pasted into Terminal fetches the
// same script with curl, which does neither - so it just runs.
//
// The script carries the API key, so the URL holds a random single-use token that
// expires after 15 minutes, handed out only to an admin on the settings page.

const CLAUDE_SETUP_TTL = 15 * MINUTE_IN_SECONDS;

add_action( 'wp_ajax_claude_setup_command', 'claude_setup_command' );
add_action( 'wp_ajax_claude_setup', 'claude_setup_serve' );
add_action( 'wp_ajax_nopriv_claude_setup', 'claude_setup_serve' );
add_action( 'wp_ajax_claude_setup_json', 'claude_setup_json' );
add_action( 'wp_ajax_nopriv_claude_setup_json', 'claude_setup_json' );

/** Settings page → a fresh Terminal command with its own single-use token. */
function claude_setup_command() {
    if ( ! current_user_can( 'manage_options' ) ) wp_send_json_error( 'Unauthorized', 403 );
    check_ajax_referer( 'claude_setup_command' );

    $token = wp_generate_password( 32, false, false );
    set_transient( 'claude_setup_' . hash( 'sha256', $token ), 'mac', CLAUDE_SETUP_TTL );
    $link = add_query_arg( array( 'action' => 'claude_setup', 't' => $token ), admin_url( 'admin-ajax.php' ) );

    // "Connect on this Mac": a claude-connector:// link the Site Maintenance app
    // (dashboard/shortcut.js) handles. It carries where to fetch the site's details
    // from - with its own single-use token - not the details themselves.
    $json_token = wp_generate_password( 32, false, false );
    set_transient( 'claude_setup_' . hash( 'sha256', $json_token ), 'json', CLAUDE_SETUP_TTL );
    $endpoint = add_query_arg( array( 'action' => 'claude_setup_json', 't' => $json_token ), admin_url( 'admin-ajax.php' ) );

    wp_send_json_success( array(
        // bash -c "$(curl …)" rather than curl | bash: npm install inside the script
        // would otherwise read the rest of the script from the pipe as its stdin.
        'command'    => 'bash -c "$(curl -fsSL \'' . $link . '\')"',
        'connect'    => 'claude-connector://connect?endpoint=' . rawurlencode( $endpoint ),
        'expires_in' => CLAUDE_SETUP_TTL,
    ) );
}

/** The Site Maintenance app's request for "Connect on this Mac": the site's details as JSON, once. */
function claude_setup_json() {
    $token = preg_replace( '/[^A-Za-z0-9]/', '', (string) ( $_GET['t'] ?? '' ) );
    $key   = 'claude_setup_' . hash( 'sha256', $token );
    nocache_headers();
    if ( $token === '' || get_transient( $key ) !== 'json' ) {
        wp_send_json_error( array( 'message' => 'This connect link has expired or was already used. In WP Admin go to Settings > Claude Connector and click Connect on this Mac again.' ), 410 );
    }
    delete_transient( $key );
    $site = claude_script_site();
    wp_send_json_success( array(
        'url'            => $site['url'],
        'key'            => $site['key'],
        'mode'           => 'ajax',
        'slug'           => $site['slug'],
        'name'           => $site['name'],
        'claude_md'      => claude_script_claude_md( $site['name'], $site['url'] ),
        'plugin_version' => CLAUDE_CONNECTOR_VERSION,
    ) );
}

/** The pasted command's request: serve the script once, then the token is gone. */
function claude_setup_serve() {
    $token = preg_replace( '/[^A-Za-z0-9]/', '', (string) ( $_GET['t'] ?? '' ) );
    $key   = 'claude_setup_' . hash( 'sha256', $token );
    $os    = $token !== '' ? get_transient( $key ) : false;

    nocache_headers();
    header( 'Content-Type: text/plain; charset=utf-8' );
    header( 'X-Content-Type-Options: nosniff' );

    if ( $os !== 'mac' ) {
        // Still a runnable script, so the pasted command explains itself rather than failing silently.
        echo "echo ''; echo 'This setup command has expired or was already used. In WP Admin go to Settings > Claude Connector and copy a new one.'; exit 1\n";
        exit;
    }
    delete_transient( $key );

    // Run from a Terminal the user already has open - no "press Enter to close" pauses.
    echo preg_replace( '/^(\s*)read -p "Press Enter[^"\n]*"\s*$/m', '$1:', claude_script_for( 'mac', claude_script_site() ) );
    exit;
}

function claude_script_claude_md( $name, $url ) {
    return "# {$name}\n\n"
        . "WordPress site managed via Claude Connector (Admin AJAX mode).\n\n"
        . "**URL:** {$url}\n\n"
        . "## Getting started\n\n"
        . "The MCP server is running and connected. All tools are ready - just ask:\n\n"
        . "- \"Check the site status\" - runs wp_status\n"
        . "- \"List recent posts\" - runs wp_posts_list\n"
        . "- \"Run wp plugin list\" - runs wp_wpcli\n"
        . "- \"Read the file themes/mytheme/functions.php\" - runs wp_files_read\n\n"
        . "## Designing or building pages\n\n"
        . "Before building anything in Divi or Elementor, read the playbook: "
        . "https://github.com/wisnuub/claude-connector/blob/main/BUILDING.md - it covers the design method and "
        . "the safety rules for a live client site (new page only, password + noindex preview, library templates). "
        . "Use `wp_page_screenshot` to look at what you built, desktop and mobile, after every meaningful change.\n\n"
        . "## Shared knowledge base\n\n"
        . "Before troubleshooting an unfamiliar WordPress/Elementor/Divi/hosting issue, call "
        . "`wp_knowledge_search` - it may already be documented from a previous site. After resolving "
        . "something non-obvious, call `wp_knowledge_add` with a generalized description (no "
        . "site-specific names, URLs, or secrets) so future sessions don't rediscover it. Writing "
        . "requires the GitHub CLI (`gh`) to be installed and logged in - if it isn't, mention that to "
        . "the user rather than skipping silently.\n\n"
        . "## Site notes\n"
        . "<!-- Add client notes, active theme, key plugins, custom post types, etc. here -->\n";
}

function claude_script_mac( $url, $key, $slug, $name ) {
    $repo    = 'https://raw.githubusercontent.com/wisnuub/claude-connector/main/mcp-server';
    $mcp_tpl = json_encode( array(
        'mcpServers' => array(
            'claude-connector' => array(
                'command' => 'node',
                'args'    => array( '__MCP__/index.js' ),
                'env'     => array( 'WP_URL' => $url, 'WP_KEY' => $key, 'WP_MODE' => 'ajax' ),
            ),
        ),
    ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );

    $mcp_b64 = base64_encode( $mcp_tpl );
    $md_b64  = base64_encode( claude_script_claude_md( $name, $url ) );

    // Nowdoc: bash $vars are preserved; {{PLACEHOLDERS}} are replaced by PHP strtr below.
    $script = <<<'BASH'
#!/bin/bash
# Claude Connector - {{NAME}}
# Double-click this file in Finder to run.
set -e

MCP_DIR="$HOME/claude-sites/.mcp-server"
SITE_DIR="$HOME/claude-sites/{{SLUG}}"

echo ""
echo "Claude Connector - {{NAME}}"
echo "────────────────────────────────────────"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install it from https://nodejs.org then run this script again."
  read -p "Press Enter to close..."
  exit 1
fi

# MCP server (shared across all sites, downloaded once)
if [ ! -d "$MCP_DIR/node_modules" ]; then
  echo "→ Downloading MCP server..."
  mkdir -p "$MCP_DIR"
  curl -sL "{{REPO}}/index.js"     -o "$MCP_DIR/index.js"
  # index.js imports ./knowledge.js, so the server will not start without it.
  curl -sL "{{REPO}}/knowledge.js" -o "$MCP_DIR/knowledge.js"
  curl -sL "{{REPO}}/screenshot.js" -o "$MCP_DIR/screenshot.js"
  curl -sL "{{REPO}}/package.json" -o "$MCP_DIR/package.json"
  echo "→ Installing dependencies..."
  (cd "$MCP_DIR" && npm install --silent)
else
  echo "→ MCP server already installed, refreshing it..."
  # Refresh even on an existing install: a stale index.js silently fails to
  # register newer tools, which is far harder to notice than an error.
  curl -sL "{{REPO}}/index.js"     -o "$MCP_DIR/index.js"
  curl -sL "{{REPO}}/knowledge.js" -o "$MCP_DIR/knowledge.js"
  curl -sL "{{REPO}}/screenshot.js" -o "$MCP_DIR/screenshot.js"
  curl -sL "{{REPO}}/package.json" -o "$MCP_DIR/package.json"
  (cd "$MCP_DIR" && npm install --silent)
fi

# Site workspace
mkdir -p "$SITE_DIR"

# Write .mcp.json - replace __MCP__ placeholder with real path
echo "{{MCP_B64}}" | base64 -d | sed "s|__MCP__|$MCP_DIR|g" > "$SITE_DIR/.mcp.json"

# Write CLAUDE.md (skip if already customised)
if [ ! -f "$SITE_DIR/CLAUDE.md" ]; then
  echo "{{MD_B64}}" | base64 -d > "$SITE_DIR/CLAUDE.md"
fi

# Open VSCode
echo "→ Opening VSCode..."
code "$SITE_DIR" 2>/dev/null \
  || open -a "Visual Studio Code" "$SITE_DIR" 2>/dev/null \
  || echo "  Open this folder in VSCode manually: $SITE_DIR"

echo ""
echo "✓ Done! Claude Code will connect automatically when VSCode opens."
echo "  Read CLAUDE.md in your new workspace for site context."
echo ""
read -p "Press Enter to close this window..."
BASH;

    $script = strtr( $script, array(
        '{{NAME}}'    => $name,
        '{{SLUG}}'    => $slug,
        '{{REPO}}'    => $repo,
        '{{MCP_B64}}' => $mcp_b64,
        '{{MD_B64}}'  => $md_b64,
    ) );

    return $script;
}

function claude_script_windows( $url, $key, $slug, $name ) {
    $repo    = 'https://raw.githubusercontent.com/wisnuub/claude-connector/main/mcp-server';
    $mcp_tpl = json_encode( array(
        'mcpServers' => array(
            'claude-connector' => array(
                'command' => 'node',
                'args'    => array( '__MCP__/index.js' ),
                'env'     => array( 'WP_URL' => $url, 'WP_KEY' => $key, 'WP_MODE' => 'ajax' ),
            ),
        ),
    ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );

    $mcp_b64 = base64_encode( $mcp_tpl );
    $md_b64  = base64_encode( claude_script_claude_md( $name, $url ) );

    // Nowdoc: PowerShell $vars are preserved; {{PLACEHOLDERS}} replaced by PHP strtr.
    $script = <<<'PS'
# Claude Connector - {{NAME}}
# Right-click this file and select "Run with PowerShell"

# Relaunch elevated - matches setups where VSCode/Node tooling normally run as Administrator.
$Identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal( $Identity )
if (-not $Principal.IsInRole( [Security.Principal.WindowsBuiltInRole]::Administrator )) {
    try {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    } catch {
        Write-Host ""
        Write-Host "Elevation was cancelled - re-run and approve the UAC prompt to continue." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "Press Enter to close"
    }
    exit
}

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

try {

$McpDir  = "$env:USERPROFILE\claude-sites\.mcp-server"
$SiteDir = "$env:USERPROFILE\claude-sites\{{SLUG}}"

Write-Host ""
Write-Host "Claude Connector - {{NAME}}"
Write-Host "----------------------------------------"

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js not found. Install it from https://nodejs.org then run this script again."
    Read-Host "Press Enter to close"
    exit 1
}

# raw.githubusercontent.com rate-limits bursts of requests (429) - retry with backoff.
function Get-FileWithRetry($SourceUrl, $DestPath) {
    for ($Attempt = 1; $Attempt -le 4; $Attempt++) {
        try {
            Invoke-WebRequest $SourceUrl -OutFile $DestPath -UseBasicParsing
            return
        } catch {
            if ($Attempt -eq 4) { throw }
            Write-Host "   retrying in $($Attempt * 2)s ($($_.Exception.Message))..."
            Start-Sleep -Seconds ($Attempt * 2)
        }
    }
}

# MCP server (shared across all sites, downloaded once)
if (-not (Test-Path "$McpDir\node_modules")) {
    Write-Host "-> Downloading MCP server..."
    New-Item -ItemType Directory -Force -Path $McpDir | Out-Null
    Get-FileWithRetry "{{REPO}}/index.js"     "$McpDir\index.js"
    # index.js imports ./knowledge.js, so the server will not start without it.
    Get-FileWithRetry "{{REPO}}/knowledge.js" "$McpDir\knowledge.js"
    Get-FileWithRetry "{{REPO}}/screenshot.js" "$McpDir\screenshot.js"
    Get-FileWithRetry "{{REPO}}/package.json" "$McpDir\package.json"
    Write-Host "-> Installing dependencies..."
    Push-Location $McpDir; npm install --silent; Pop-Location
} else {
    Write-Host "-> MCP server already installed, refreshing it..."
    # Refresh even on an existing install: a stale index.js silently fails to
    # register newer tools, which is far harder to notice than an error.
    Get-FileWithRetry "{{REPO}}/index.js"     "$McpDir\index.js"
    Get-FileWithRetry "{{REPO}}/knowledge.js" "$McpDir\knowledge.js"
    Get-FileWithRetry "{{REPO}}/screenshot.js" "$McpDir\screenshot.js"
    Get-FileWithRetry "{{REPO}}/package.json" "$McpDir\package.json"
    Push-Location $McpDir; npm install --silent; Pop-Location
}

# Site workspace
New-Item -ItemType Directory -Force -Path $SiteDir | Out-Null

# Write .mcp.json - decode base64, replace __MCP__ placeholder with real path
$McpBytes = [System.Convert]::FromBase64String('{{MCP_B64}}')
$McpText  = [System.Text.Encoding]::UTF8.GetString($McpBytes)
$McpText  = $McpText.Replace('__MCP__', $McpDir.Replace('\', '/'))
[System.IO.File]::WriteAllText("$SiteDir\.mcp.json", $McpText, [System.Text.Encoding]::UTF8)

# Write CLAUDE.md (skip if already customised)
if (-not (Test-Path "$SiteDir\CLAUDE.md")) {
    $MdBytes = [System.Convert]::FromBase64String('{{MD_B64}}')
    $MdText  = [System.Text.Encoding]::UTF8.GetString($MdBytes)
    [System.IO.File]::WriteAllText("$SiteDir\CLAUDE.md", $MdText, [System.Text.Encoding]::UTF8)
}

# Open VSCode
Write-Host "-> Opening VSCode..."
try {
    code $SiteDir
} catch {
    Write-Host "  Open this folder in VSCode manually: $SiteDir"
}

Write-Host ""
Write-Host "Done! Claude Code will connect automatically when VSCode opens."
Write-Host "Read CLAUDE.md in your new workspace for site context."
Write-Host ""
Read-Host "Press Enter to close"

} catch {
    Write-Host ""
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
PS;

    $script = strtr( $script, array(
        '{{NAME}}'    => $name,
        '{{SLUG}}'    => $slug,
        '{{REPO}}'    => $repo,
        '{{MCP_B64}}' => $mcp_b64,
        '{{MD_B64}}'  => $md_b64,
    ) );

    // Windows PowerShell 5.1 reads BOM-less script files using the system codepage, not UTF-8 -
    // without this BOM the non-ASCII characters above corrupt the token stream and the whole
    // script fails to parse (silently, since the console window closes before it can be read).
    return "\xEF\xBB\xBF" . $script;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Activation
// ──────────────────────────────────────────────────────────────────────────────

register_activation_hook( __FILE__, 'claude_activate' );

function claude_activate() {
    global $wpdb;
    claude_get_api_key(); // generate key on first activation

    $table           = $wpdb->prefix . 'claude_log';
    $charset_collate = $wpdb->get_charset_collate();
    $sql             = "CREATE TABLE IF NOT EXISTS {$table} (
        id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        time     DATETIME        NOT NULL,
        ip       VARCHAR(45)     NOT NULL DEFAULT '',
        method   VARCHAR(10)     NOT NULL DEFAULT '',
        endpoint VARCHAR(255)    NOT NULL DEFAULT '',
        status   SMALLINT        NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        KEY time (time)
    ) {$charset_collate};";

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( $sql );

    // Activated by hand in wp-admin (not WP-CLI or the API): go straight to the
    // settings page, where Connect on this Mac is.
    if ( is_admin() && ! ( defined( 'WP_CLI' ) && WP_CLI ) && ! wp_doing_ajax() ) {
        update_option( 'claude_connector_activation_redirect', 1, false );
    }
}

add_action( 'admin_init', function () {
    if ( ! get_option( 'claude_connector_activation_redirect' ) ) return;
    delete_option( 'claude_connector_activation_redirect' );
    if ( wp_doing_ajax() || is_network_admin() || isset( $_GET['activate-multi'] ) || ! current_user_can( 'manage_options' ) ) return; // phpcs:ignore
    wp_safe_redirect( admin_url( 'options-general.php?page=claude-connector&welcome=1' ) );
    exit;
} );

register_deactivation_hook( __FILE__, function () {
    // Clean up any relay cron left over from earlier versions.
    wp_clear_scheduled_hook( 'claude_relay_poll_event' );
} );
