<?php
/**
 * Plugin Name:  Claude Connector
 * Plugin URI:   https://github.com/wisnuub/claude-connector
 * Description:  Secure REST API bridge for Claude AI - ACF sync, cache purge, file management, database queries, post CRUD, plugin/theme control, and more.
 * Version:      1.4.0
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

define( 'CLAUDE_CONNECTOR_VERSION', '1.4.0' );
define( 'CLAUDE_CONNECTOR_NS',      'claude/v1' );
define( 'CLAUDE_CONNECTOR_GH_REPO', 'wisnuub/claude-connector' );

// PHP 7.x polyfills ────────────────────────────────────────────────────────────
if ( ! function_exists( 'str_starts_with' ) ) {
    function str_starts_with( string $haystack, string $needle ): bool {
        return $needle === '' || strncmp( $haystack, $needle, strlen( $needle ) ) === 0;
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
 * REST permission callback.
 * Expects the API key in X-Claude-Key header (preferred) or ?_key= param.
 *
 * @param  WP_REST_Request $req
 * @return true|WP_Error
 */
function claude_auth( $req ) {
    $header   = $req->get_header( 'X-Claude-Key' );
    $param    = $req->get_param( '_key' );
    $provided = (string) ( $header !== null ? $header : ( $param !== null ? $param : '' ) );

    if ( $provided === '' ) {
        return new WP_Error( 'unauthorized', 'Missing API key. Send X-Claude-Key header.', array( 'status' => 401 ) );
    }
    if ( ! hash_equals( claude_get_api_key(), $provided ) ) {
        return new WP_Error( 'unauthorized', 'Invalid API key.', array( 'status' => 401 ) );
    }
    // Warn if key was sent as a URL param (appears in server logs)
    if ( $param && ! $header ) {
        trigger_error( 'Claude Connector: API key passed via URL param - use X-Claude-Key header instead.', E_USER_WARNING );
    }
    return true;
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

    $key        = claude_get_api_key();
    $base_url   = rest_url( CLAUDE_CONNECTOR_NS );
    $status_url = add_query_arg( '_key', $key, rest_url( CLAUDE_CONNECTOR_NS . '/status' ) );

    $last_access = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}claude_log ORDER BY id DESC LIMIT 1", ARRAY_A );

    $endpoints = array(
        array( 'GET',    '/status',          'Site info, WP/PHP version, active theme & plugins' ),
        array( 'GET',    '/acf/groups',       'List ACF field groups and sync status' ),
        array( 'POST',   '/acf/sync',         'Sync field groups from local JSON' ),
        array( 'POST',   '/cache/purge',      'Flush all caches (WPEngine, W3TC, Rocket, etc.)' ),
        array( 'GET',    '/posts',            'Query posts by type, status, search, taxonomy' ),
        array( 'POST',   '/posts',            'Create a post' ),
        array( 'GET',    '/posts/{id}',       'Get post with all meta & taxonomy terms' ),
        array( 'PUT',    '/posts/{id}',       'Update a post' ),
        array( 'DELETE', '/posts/{id}',       'Delete a post' ),
        array( 'GET',    '/options?key=',     'Read a WordPress option' ),
        array( 'POST',   '/options',          'Write a WordPress option' ),
        array( 'GET',    '/plugins',          'List all plugins with active status' ),
        array( 'POST',   '/plugins',          'Activate or deactivate a plugin' ),
        array( 'GET',    '/themes',           'List installed themes' ),
        array( 'POST',   '/themes',           'Switch active theme' ),
        array( 'GET',    '/files?path=',      'List files in a wp-content subdirectory' ),
        array( 'GET',    '/files/read',       'Read a file\'s content' ),
        array( 'POST',   '/files',            'Write (create or overwrite) a file - supports content_b64' ),
        array( 'DELETE', '/files?path=',      'Delete a file or empty directory' ),
        array( 'POST',   '/files/stage',      'Stage a base64 chunk for WAF-bypass write (use with /files/commit)' ),
        array( 'POST',   '/files/commit',     'Commit staged chunks and write file to disk' ),
        array( 'GET',    '/db/tables',        'List database tables' ),
        array( 'POST',   '/db/query',         'Execute a database query' ),
        array( 'GET',    '/logs',             'View recent API access log' ),
        array( 'POST',   '/logs/clear',       'Clear the access log' ),
        array( 'POST',   '/wpcli',            'Run a WP-CLI command - accepts args[] array or command string' ),
        array( 'POST',   '/wp-admin/admin-ajax.php?action=claude_cmd', 'Admin-AJAX mode - Cloudflare WAF bypass' ),
    );
    $colours = array( 'GET' => '#0074a2', 'POST' => '#007a3d', 'PUT' => '#856404', 'DELETE' => '#a00' );
    ?>
    <div class="wrap">
        <h1>Claude Connector <span style="font-size:13px;font-weight:400;color:#666;">v<?php echo esc_html( CLAUDE_CONNECTOR_VERSION ); ?></span></h1>
        <table class="form-table" role="presentation">
            <tr>
                <th>API Key</th>
                <td>
                    <input type="text" value="<?php echo esc_attr( $key ); ?>"
                           style="width:500px;font-family:monospace;font-size:12px;"
                           readonly onclick="this.select()">
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
                <td><a href="<?php echo esc_url( $status_url ); ?>" target="_blank" class="button button-secondary">Test connection ↗</a></td>
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
        <h2>Settings</h2>
        <form method="post">
            <?php wp_nonce_field( 'claude_save_settings' ); ?>
            <table class="form-table" role="presentation">
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
        <p class="description">Download a one-click setup script for your computer. It installs the MCP bridge, creates a workspace folder for this site, and opens it in VSCode - Claude Code connects automatically.</p>
        <p style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">
            <a id="claude-dl-mac" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-ajax.php?action=claude_connect_script&os=mac' ), 'claude_connect_script' ) ); ?>"
               class="button button-primary" style="font-size:13px;">&#8984;&nbsp; Download Mac Script (.command)</a>
            <a id="claude-dl-windows" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-ajax.php?action=claude_connect_script&os=windows' ), 'claude_connect_script' ) ); ?>"
               class="button button-primary" style="font-size:13px;">&#x229e;&nbsp; Download Windows Script (.ps1)</a>
        </p>
        <p class="description" style="margin-top:8px;">
            <strong>Mac:</strong> double-click the <code>.command</code> file in Finder &mdash;
            <strong>Windows:</strong> right-click the <code>.ps1</code> file &rarr; Run with PowerShell.<br>
            Requires Node.js (<a href="https://nodejs.org" target="_blank">nodejs.org</a>) and VSCode with the Claude Code extension.
        </p>
        <script>
        (function () {
            // Progressive enhancement: both buttons render by default (works with JS off);
            // hide whichever one doesn't match the visitor's OS.
            var ua    = navigator.userAgent || '';
            var isWin = /Windows/i.test( ua );
            var isMac = /Macintosh|Mac OS X/i.test( ua ) && ! isWin;
            if ( isWin ) {
                document.getElementById( 'claude-dl-mac' ).style.display = 'none';
            } else if ( isMac ) {
                document.getElementById( 'claude-dl-windows' ).style.display = 'none';
            }
            // Unrecognised platform (Linux, etc.) - leave both visible.
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

    register_rest_route( $ns, '/status',             array( 'methods' => 'GET',    'callback' => 'claude_status',         'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/groups',         array( 'methods' => 'GET',    'callback' => 'claude_acf_groups',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/acf/sync',           array( 'methods' => 'POST',   'callback' => 'claude_acf_sync',       'permission_callback' => $a ) );
    register_rest_route( $ns, '/cache/purge',        array( 'methods' => 'POST',   'callback' => 'claude_cache_purge',    'permission_callback' => $a ) );
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
    register_rest_route( $ns, '/files/stage',  array( 'methods' => 'POST', 'callback' => 'claude_files_stage',  'permission_callback' => $a ) );
    register_rest_route( $ns, '/files/commit', array( 'methods' => 'POST', 'callback' => 'claude_files_commit', 'permission_callback' => $a ) );
    register_rest_route( $ns, '/db/tables',    array( 'methods' => 'GET',  'callback' => 'claude_db_tables',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/db/query',     array( 'methods' => 'POST', 'callback' => 'claude_db_query',     'permission_callback' => $a ) );
    register_rest_route( $ns, '/logs',         array( 'methods' => 'GET',  'callback' => 'claude_logs_list',    'permission_callback' => $a ) );
    register_rest_route( $ns, '/logs/clear',   array( 'methods' => 'POST', 'callback' => 'claude_logs_clear',   'permission_callback' => $a ) );
    register_rest_route( $ns, '/wpcli',        array( 'methods' => 'POST', 'callback' => 'claude_wpcli',        'permission_callback' => $a ) );
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

// ──────────────────────────────────────────────────────────────────────────────
//  Cache
// ──────────────────────────────────────────────────────────────────────────────

function claude_cache_purge() {
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
                      'post_parent', 'page_template', 'comment_status', 'meta_input' );
    $data    = array_intersect_key( (array) $req->get_json_params(), array_flip( $allowed ) );
    if ( empty( $data['post_title'] ) && empty( $data['post_content'] ) ) {
        return new WP_Error( 'missing', 'post_title or post_content is required.', array( 'status' => 400 ) );
    }
    $id = wp_insert_post( $data, true );
    if ( is_wp_error( $id ) ) return $id;
    return new WP_REST_Response( claude_format_post( get_post( $id ) ), 201 );
}

function claude_posts_update( $req ) {
    $post = get_post( (int) $req['id'] );
    if ( ! $post ) return new WP_Error( 'not_found', 'Post not found.', array( 'status' => 404 ) );
    $allowed    = array( 'post_title', 'post_content', 'post_excerpt', 'post_status',
                         'post_name', 'menu_order', 'page_template', 'comment_status', 'meta_input' );
    $data       = array_intersect_key( (array) $req->get_json_params(), array_flip( $allowed ) );
    $data['ID'] = $post->ID;
    $id         = wp_update_post( $data, true );
    if ( is_wp_error( $id ) ) return $id;
    return new WP_REST_Response( claude_format_post( get_post( $id ) ) );
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

function claude_options_get( $req ) {
    $key = sanitize_text_field( (string) $req->get_param( 'key' ) );
    if ( ! $key ) return new WP_Error( 'missing', 'Provide ?key=option_name.', array( 'status' => 400 ) );
    return new WP_REST_Response( array( 'key' => $key, 'value' => get_option( $key ) ) );
}

function claude_options_set( $req ) {
    $body  = (array) $req->get_json_params();
    $key   = sanitize_text_field( (string) ( $body['key'] ?? '' ) );
    $value = $body['value'] ?? null;
    if ( ! $key ) return new WP_Error( 'missing', 'Body must include "key".', array( 'status' => 400 ) );
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
    if ( ! $plugin || ! $action ) {
        return new WP_Error( 'missing', 'Body must include "plugin" and "action".', array( 'status' => 400 ) );
    }
    if ( $action === 'activate' ) {
        $result = activate_plugin( $plugin );
        if ( is_wp_error( $result ) ) return $result;
        return new WP_REST_Response( array( 'activated' => $plugin ) );
    }
    if ( $action === 'deactivate' ) {
        deactivate_plugins( $plugin );
        return new WP_REST_Response( array( 'deactivated' => $plugin ) );
    }
    return new WP_Error( 'invalid_action', 'action must be "activate" or "deactivate".', array( 'status' => 400 ) );
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
    if ( ! wp_get_theme( $stylesheet )->exists() ) {
        return new WP_Error( 'not_found', "Theme '{$stylesheet}' not found.", array( 'status' => 404 ) );
    }
    switch_theme( $stylesheet );
    return new WP_REST_Response( array( 'active_theme' => get_stylesheet() ) );
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

    // Path doesn't exist yet (new file) - verify its parent is inside the boundary.
    $parent = realpath( dirname( $target ) );
    if ( $parent === false ) return false;
    return ( $parent === $base || str_starts_with( $parent, $base . DIRECTORY_SEPARATOR ) )
        ? $target : false;
}

function claude_files_list( $req ) {
    $path = claude_safe_path( sanitize_text_field( (string) $req->get_param( 'path' ) ) );
    if ( ! $path )           return new WP_Error( 'forbidden', 'Path is outside wp-content.',  array( 'status' => 403 ) );
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
    if ( ! $path )            return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );
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
    if ( ! $path ) return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );
    wp_mkdir_p( dirname( $path ) );
    $bytes = file_put_contents( $path, $content ); // phpcs:ignore
    if ( $bytes === false ) return new WP_Error( 'write_failed', 'Could not write file.', array( 'status' => 500 ) );
    return new WP_REST_Response( array( 'written' => $rel, 'bytes' => $bytes ) );
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
    if ( ! $path ) return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );

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
    if ( ! $path ) return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );

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

    wp_mkdir_p( dirname( $path ) );
    $bytes = file_put_contents( $path, $content ); // phpcs:ignore
    if ( $bytes === false ) {
        return new WP_Error( 'write_failed', 'Could not write file.', array( 'status' => 500 ) );
    }

    for ( $i = 0; $i < $chunk_total; $i++ ) {
        delete_transient( 'claude_stage_' . md5( $rel ) . '_' . $i );
    }

    return new WP_REST_Response( array( 'written' => $rel, 'bytes' => $bytes ) );
}

function claude_files_delete( $req ) {
    $rel  = sanitize_text_field( (string) $req->get_param( 'path' ) );
    $path = claude_safe_path( $rel );
    if ( ! $path )              return new WP_Error( 'forbidden', 'Path is outside wp-content.', array( 'status' => 403 ) );
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
    $body  = (array) $req->get_json_params();
    $query = $body['query'] ?? null;
    $type  = strtolower( (string) ( $body['type'] ?? 'get_results' ) );

    if ( ! $query ) return new WP_Error( 'missing', 'Body must include "query".', array( 'status' => 400 ) );

    $allowed = array( 'get_results', 'get_row', 'get_var', 'get_col', 'query' );
    if ( ! in_array( $type, $allowed, true ) ) {
        return new WP_Error( 'invalid_type', 'type must be one of: ' . implode( ', ', $allowed ), array( 'status' => 400 ) );
    }

    // Replaced PHP 8.0 match() with switch for PHP 7.4 compatibility.
    switch ( $type ) {
        case 'get_row':     $result = $wpdb->get_row( $query, ARRAY_A ); break;  // phpcs:ignore
        case 'get_var':     $result = $wpdb->get_var( $query );          break;  // phpcs:ignore
        case 'get_col':     $result = $wpdb->get_col( $query );          break;  // phpcs:ignore
        case 'query':       $result = $wpdb->query( $query );            break;  // phpcs:ignore
        default:            $result = $wpdb->get_results( $query, ARRAY_A );     // phpcs:ignore
    }

    if ( $wpdb->last_error ) return new WP_Error( 'db_error', $wpdb->last_error, array( 'status' => 500 ) );
    return new WP_REST_Response( array(
        'result'     => $result,
        'rows'       => is_array( $result ) ? count( $result ) : null,
        'last_query' => $wpdb->last_query,
    ) );
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

    // Real IP - check Cloudflare first, then common proxies, then REMOTE_ADDR.
    $ip = '0.0.0.0';
    foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $key ) {
        if ( ! empty( $_SERVER[ $key ] ) ) {
            $ip = sanitize_text_field( trim( explode( ',', $_SERVER[ $key ] )[0] ) );
            break;
        }
    }

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
 * Authenticates via X-Claude-Key header or ?_key= param, then dispatches
 * the command internally using claude_relay_execute() - no second HTTP
 * request, no Cloudflare/Imunify involvement after this point.
 */
function claude_ajax_handler() {
    $provided = trim( (string) ( $_SERVER['HTTP_X_CLAUDE_KEY'] ?? $_REQUEST['_key'] ?? '' ) );
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

    // Block interactive sub-commands that hang waiting for input.
    $blocked = array( 'shell', 'server' );
    if ( in_array( strtolower( $args[0] ), $blocked, true ) ) {
        return new WP_Error( 'blocked', "wp {$args[0]} is interactive and cannot run via this endpoint.", array( 'status' => 400 ) );
    }

    return new WP_REST_Response( claude_wpcli_run( $args ) );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Connect Script - downloadable one-click setup for Mac or Windows
// ──────────────────────────────────────────────────────────────────────────────

add_action( 'wp_ajax_claude_connect_script', 'claude_connect_script_download' );

function claude_connect_script_download() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Unauthorized', '', array( 'response' => 403 ) );
    check_ajax_referer( 'claude_connect_script' );

    $os   = sanitize_key( $_GET['os'] ?? 'mac' );
    $url  = rtrim( get_site_url(), '/' );
    $key  = claude_get_api_key();
    $host = (string) parse_url( $url, PHP_URL_HOST );
    $host = preg_replace( '/^www\./', '', $host );
    $slug = strtolower( explode( '.', $host )[0] );
    $slug = preg_replace( '/[^a-z0-9]+/', '-', $slug );
    $name = ucfirst( str_replace( '-', ' ', $slug ) );

    if ( $os === 'windows' ) {
        claude_script_windows( $url, $key, $slug, $name );
    } else {
        claude_script_mac( $url, $key, $slug, $name );
    }
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
  curl -sL "{{REPO}}/package.json" -o "$MCP_DIR/package.json"
  echo "→ Installing dependencies..."
  (cd "$MCP_DIR" && npm install --silent)
else
  echo "→ MCP server already installed."
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

    header( 'Content-Type: application/octet-stream' );
    header( "Content-Disposition: attachment; filename=\"connect-{$slug}.command\"" );
    header( 'X-Content-Type-Options: nosniff' );
    echo $script;
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
    Get-FileWithRetry "{{REPO}}/package.json" "$McpDir\package.json"
    Write-Host "-> Installing dependencies..."
    Push-Location $McpDir; npm install --silent; Pop-Location
} else {
    Write-Host "-> MCP server already installed."
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

    header( 'Content-Type: application/octet-stream' );
    header( "Content-Disposition: attachment; filename=\"connect-{$slug}.ps1\"" );
    header( 'X-Content-Type-Options: nosniff' );
    // Windows PowerShell 5.1 reads BOM-less script files using the system codepage, not UTF-8 -
    // without this BOM the non-ASCII characters above corrupt the token stream and the whole
    // script fails to parse (silently, since the console window closes before it can be read).
    echo "\xEF\xBB\xBF" . $script;
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

}

register_deactivation_hook( __FILE__, function () {
    // Clean up any relay cron left over from earlier versions.
    wp_clear_scheduled_hook( 'claude_relay_poll_event' );
} );
