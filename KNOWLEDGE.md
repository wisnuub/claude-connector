# Claude Connector — Shared Knowledge Base

Fixes and gotchas discovered while operating on WordPress sites through Claude Connector,
recorded by Claude via the `wp_knowledge_add` MCP tool so future sessions on any site don't
rediscover the same thing from scratch. Read via `wp_knowledge_search` before troubleshooting
an unfamiliar problem.

Entries are generalized on purpose — no site names, URLs, or secrets.

## Elementor

- **Symptom:** Writing JSON to `_elementor_data` via `update_post_meta()` sometimes corrupts escaped characters (e.g. `\"` or `\n` inside strings) and Elementor fails to load the page. **Fix:** Wrap the JSON string in `wp_slash()` before calling `update_post_meta()`. **Why:** `update_metadata()` always calls `wp_unslash()` internally before storing, so unescaped backslash sequences get stripped unless they were slashed first — this is the same pattern Elementor's own `Document::save()` uses.

## Divi

- **Symptom:** After installing or updating *any* plugin on a Divi site, every page loses its Divi-attribute styling at once — text colours, alignment, spacing all revert, and the client reports "the pages look bad now, they were fine before". Nothing in `post_content` has changed and the builder still opens correctly. **Fix:** Re-save every builder post (`wp_divi_resave`, or `wp post update <ids> --post_status=publish`), then confirm with `wp_divi_audit`. **Why:** The install invalidates Divi's cached per-post CSS, and the regeneration can emit per-module selectors whose indices are offset by that page's own module count — the stylesheet targets `.et_pb_text_0` while the markup renders `.et_pb_text_12`, so nothing matches. Re-saving forces a clean regeneration. Detect it by extracting `.et_pb_<type>_<n>` selectors from the generated CSS and checking each one actually exists as a class in the rendered HTML.

- **Symptom:** A newly created Divi 5 page shows the theme's default template — WordPress widget sidebar, duplicated page title, no builder layout — even though `post_content` holds perfectly valid `<!-- wp:divi/... -->` markup. **Fix:** Divi 5 needs five postmeta rows, not just one: `_et_pb_use_builder=on`, `_et_pb_use_divi_5=on`, `_et_pb_page_layout=et_no_sidebar`, `_et_pb_side_nav=off`, `_et_pb_post_hide_nav=default`. Use `wp_divi_data_set` or `wp_divi_meta_set`, which apply the whole set. **Why:** `_et_pb_use_builder` alone is enough for Divi 4 but not for Divi 5's layout system, and `wp post create` sets none of them. The page looks broken while the database looks correct, so it is easy to misdiagnose as a content problem.

- **Symptom:** Divi 5 module attributes set in `post_content` are silently ignored — the module renders with defaults and no error appears anywhere. **Fix:** Never guess Divi 5 attribute paths; read them off a page a human already built in the UI (`SELECT post_content FROM wp_posts WHERE ID = <a built page>`) or from Divi's generated schema JSON under `wp-content/themes/Divi/`. Verified traps: centring text is `module.advanced.text.text.desktop.value.orientation`, **not** `font.textAlign` (setting textAlign emits a duplicate declaration that loses); `divi/image` puts its content in `image.innerContent`, `divi/icon` in `icon.innerContent`, everything else in `content.innerContent`; every leaf needs the `{breakpoint:{value:…}}` wrapper even for desktop-only values. **Why:** Divi 5 attributes are a deep JSON tree with no validation on write — an unrecognised path is just dropped.

- **Symptom:** A SQL `REPLACE()` against builder content matches nothing, even though you can plainly see the string in the page. Searching for `<h1>Title</h1>` returns zero rows. **Fix:** Use `wp_content_replace`, which takes plain HTML and works out the encoding itself. If you must hand-write SQL, note that block attributes are JSON inside an HTML comment, so the HTML within them is escaped — and *how* depends on what wrote it: the Divi 5 visual builder escapes angle brackets as `<` / `>` while keeping quotes as `\"`, whereas hand-written block JSON leaves the brackets literal and escapes only the quotes. Both forms coexist on the same site, in the same page. **Why:** WordPress's `serialize_block_attributes()` escapes `<`, `>`, `&`, `--` and `\"` to their `\uXXXX` forms so the JSON is safe inside an HTML comment; anything that writes `post_content` directly, rather than through the builder, skips that step. A third trap: passing these escape sequences through a JSON tool payload adds another layer, so a literal `<` needs its backslash doubled — three levels of escaping in total, and getting it wrong silently matches nothing rather than erroring.

- **Symptom:** Custom CSS loaded through Divi → Theme Options → Integration → Head loses to Divi's own rules even with `!important`. **Fix:** Raise specificity instead of adding more `!important` — prefix contested selectors with `html body`. **Why:** Integration → Head prints *before* Divi enqueues its unified stylesheet, so on an `!important` tie Divi wins on source order. Two extra element selectors beat Divi's single-class rules regardless of order.

- **Symptom:** Padding or a background set on a page's first section doesn't apply, and/or a selector meant for the page's hero also hits the Theme Builder header. **Fix:** Scope structurally rather than by index: `.et-l--post > .et_builder_inner_content > .et_pb_section:first-child`. **Why:** Divi's critical-CSS optimisation can drop first-section styles from the deferred stylesheet, and both the header template and the page body emit an `.et_pb_section_0`, so index-based selectors are ambiguous. `.et-l--post` cannot leak into the header or footer templates. Related: a Theme Builder header that is `position:fixed` on desktop is often `position:relative` at ≤767px, so phone hero padding needs to be much smaller, not proportionally scaled.

- **Symptom:** Edits made to `post_content` with raw SQL appear in the database but the front end keeps serving the old styling. **Fix:** Delete the `_divi_dynamic_assets_cached_*` postmeta for that post, re-save the post, then purge caches — `wp_cache_purge` with `builder: true`, or `wp_divi_resave` which does all of it. **Why:** SQL bypasses every WordPress hook, so Divi never learns the content changed. Divi caches per-post CSS both in `wp-content/et-cache/<id>/` and in that postmeta; clearing the object cache alone does nothing for either.

- **Symptom:** Divi's performance options look like the cause of a CSS problem, so turning them off seems sensible. **Fix:** Leave `divi_dynamic_module_framework`, `divi_critical_css` and `divi_defer_block_css` **on**. **Why:** Turning them off breaks the navigation menu and drops hero background images. The critical-CSS behaviour is genuinely awkward (see the first-section entry above) but the workaround is a scoped selector, not disabling the feature.

## ACF

- **Symptom:** ACF's `update_field()` has historically had its own additional stripslashes step on top of core's, so wrapping a value in `wp_slash()` isn't always sufficient to protect literal backslashes — reports of this go back years across ACF versions with inconsistent behavior. **Fix:** Not yet resolved here; verify against the actual ACF version on a live site before assuming `wp_slash()` alone is enough for field values containing backslashes. **Why:** Unconfirmed — flagging as a known risk area rather than a verified fix.

## Hosting & WAF

## WP-CLI & Database

## General

- **Symptom:** `wp_insert_post()` / `wp_update_post()` silently strip literal backslash characters (Windows paths, regex, escaped quotes in embedded code) from `post_content`/`post_title`/`meta_input` values. **Fix:** Wrap the whole data array in `wp_slash()` before passing it in. **Why:** Both functions call `wp_unslash()` internally and expect pre-slashed input, the same convention as `update_post_meta()` — `update_option()` is the opposite and must NOT be slashed, since it does no internal unslashing at all.
